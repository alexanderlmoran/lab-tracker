// SpectraCell Laboratories portal scraper.
//
// Target: https://spec-portal.com/ — Orchard Software's "Copia" web portal (the
// LIS behind SpectraCell; servlets are com.orchardsoft.*). Captured 2026-06-01
// via lab-portal-capture; HAR + recorded.js in worker/captures/spectracell/.
//
// Approach (validated 2026-06-01): the post-login Report Inbox lists every ready
// order with patient name + order id + test + dates + status as plain text. We
// read that inbox directly — the search box is a context-scoped typeahead that
// does not reproduce reliably in automation, and the inbox is the right model
// anyway (newly-available results sit at the top, which is the runtime need).
//
// Open a report by the checkbox + "Print Selected" path (avoids the order-link
// context menu, whose items differ between a frozen-pane duplicate link and the
// scroll-pane one). That opens the report in iframe[name="reportWindow"] using
// pdf.js, which fetches /pdfview/<id>.pdf (application/pdf, %PDF-1.4) — we
// capture those bytes via waitForResponse(). No Chrome-PDF-viewer trap (pdf.js,
// not the native plugin).
//
// Identifiers (from the captured rows):
//   - Order ID  e.g. "1063-00074354854-260116" = <orderSeq>-<accountNum>-<YYMMDD>.
//     The account "00074354854" is shared by ALL of the clinic's orders, so the
//     order id (not the account) is the per-order key; stored as labExternalRef.
//   - Patient   "Centner, David"  → first-time match key (name).
//   - Status "Complete" = finalized.

import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult, ProbeCandidate } from "./base.js";

const LOGIN_URL = "https://spec-portal.com/";
const USERNAME = process.env.SPECTRACELL_USERNAME;
const PASSWORD = process.env.SPECTRACELL_PASSWORD;

const ORDER_LINK_SEL = "a.orderContextMenuElement";
const ROW_CHECKBOX_SEL = "input[id^='inboxSelected_']";

type RowSnapshot = {
  orderId: string;
  patientName: string; // "Last, First"
  status: string;
};

export const spectracellScraper: LabScraper = {
  labName: "Spectracell",

  async run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!USERNAME || !PASSWORD) {
      throw new Error("SPECTRACELL_USERNAME / SPECTRACELL_PASSWORD not configured");
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000); // Orchard Copia is slow; reports take ~5-20s

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    try {
      await login(page);
      const rows = await readInboxRows(page);

      for (const c of openCases) {
        try {
          const match = matchRow(c, rows);
          if (!match) continue;
          if (!isReady(match)) continue;

          const pdf = await openReportAndCapture(page, match);
          if (!pdf) continue;

          found.push({
            caseId: c.caseId,
            labExternalRef: match.orderId,
            pdfBase64: pdf.buf.toString("base64"),
            pdfFilename: pdf.filename,
          });
        } catch (err) {
          errors.push({
            caseId: c.caseId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      await ctx.close();
    }

    return { found, errors };
  },

  // Patient-name search for the reconcile engine — finds AGED orders the inbox
  // has dropped (the gap the inbox-only run() couldn't cover). Captured 2026-06-05:
  // top search → patient filter (last+first) → click patient → Order History →
  // read the patientOrdersTable. The order-history row carries orderId, a
  // collection date, and a "Complete" status; the patient-search row carries DOB,
  // so matches are DOB-verified. Browser-driven (Orchard Copia is servlet/UI-based).
  async probeByName(
    browser: Browser,
    name: string,
    dob?: string | null,
  ): Promise<ProbeCandidate[]> {
    if (!USERNAME || !PASSWORD) {
      throw new Error("SPECTRACELL_USERNAME / SPECTRACELL_PASSWORD not configured");
    }
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);
    try {
      await login(page);
      const { last, first } = splitName(name);

      // Open the patient search, reveal the filter, type last + first name. The
      // results table narrows as-you-type, so settle before reading.
      await page.locator("#button_patient_search").click();
      await page
        .locator("#patientSearchTab")
        .getByRole("link", { name: /show filter/i })
        .click()
        .catch(() => {});
      await page.getByRole("textbox", { name: /Patient Last Name/i }).fill(last);
      if (first) {
        await page.getByRole("textbox", { name: /Patient First Name/i }).fill(first).catch(() => {});
      }
      await page.waitForTimeout(3000);

      const dobNorm = normalizeDob(dob ?? null);
      const nameNorm = normalizeName(name);

      // Find the matching patient row (name + DOB) and open its context menu.
      const pLinks = await page.locator("a.patientContextMenuElement").all();
      let patientLink: (typeof pLinks)[number] | null = null;
      for (const link of pLinks) {
        const tr = link.locator("xpath=ancestor::tr[1]");
        const cells = (await tr.locator("td").allTextContents()).map((c) => c.replace(/\s+/g, " ").trim());
        const rowName = cells.find((c) => /^[A-Za-z'’.\- ]+,\s*[A-Za-z]/.test(c)) ?? "";
        const rowDob = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) ?? null;
        if (normalizeName(rowName) === nameNorm && (dobNorm === "" || normalizeDob(rowDob) === dobNorm)) {
          patientLink = link;
          break;
        }
      }
      if (!patientLink) return [];
      const dobConfirmed = dobNorm !== "";

      await patientLink.click();
      await page.getByRole("menuitem", { name: /Order History/i }).click();
      await page.waitForTimeout(3000);

      // Read the order-history rows. Cols: orderId | specimen | test |
      // collDate ("MM/DD/YYYY hh:mmAM") | provider | status ("Complete").
      const orderLinks = await page.locator(ORDER_LINK_SEL).all();
      const seen = new Set<string>();
      const out: ProbeCandidate[] = [];
      for (const link of orderLinks) {
        const orderId = ((await link.textContent()) ?? "").replace(/\s+/g, " ").trim();
        if (!orderId || seen.has(orderId)) continue; // frozen/scroll panes duplicate
        seen.add(orderId);
        const tr = link.locator("xpath=ancestor::tr[1]");
        const cells = (await tr.locator("td").allTextContents()).map((c) => c.replace(/\s+/g, " ").trim());
        const dateCell = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}/.test(c)) ?? "";
        const statusCell =
          cells.find((c) =>
            /^(complete|in[\s-]?process|pending|preliminary|final|received|partial|cancell?ed)$/i.test(c),
          ) ?? "";
        const md = dateCell.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        out.push({
          ref: orderId || null,
          resultIssuedAt: md ? `${md[3]}-${md[1]}-${md[2]}` : null,
          collectionDate: md ? `${md[1]}/${md[2]}/${md[3]}` : null,
          status: statusCell,
          dobConfirmed,
        });
      }
      return out;
    } finally {
      await ctx.close();
    }
  },
};

// "Doe, Jane" / "Jane Doe" → { last: "Doe", first: "Jane" } for the search fields.
function splitName(name: string): { last: string; first: string } {
  const clean = name.replace(/[^a-zA-Z, ]/g, "").trim();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return { last: last ?? "", first: first ?? "" };
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return { last: parts[parts.length - 1], first: parts[0] };
  return { last: clean, first: "" };
}

function normalizeDob(s: string | null): string {
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s.trim();
}

async function login(page: Page): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill("#tUser", USERNAME!);
  await page.fill("#tPasswd", PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Inbox order rows render after login (slow site).
  await page.waitForSelector(ORDER_LINK_SEL, { state: "visible", timeout: 45_000 });
  await page.waitForTimeout(1500);
}

// Read the Report Inbox. Each row carries the order id (a link), the patient
// name + dates + status as text, and a per-row checkbox.
async function readInboxRows(page: Page): Promise<RowSnapshot[]> {
  const links = await page.locator(ORDER_LINK_SEL).all();
  const seen = new Set<string>();
  const out: RowSnapshot[] = [];
  for (const link of links) {
    const orderId = ((await link.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (!orderId || seen.has(orderId)) continue; // frozen/scroll panes duplicate links
    seen.add(orderId);
    const row = link.locator("xpath=ancestor::tr[1]");
    const cells = (await row.locator("td").allTextContents()).map((c) => c.replace(/\s+/g, " ").trim());
    // Patient name = first "Last, First" cell that isn't the ordering provider (M.D.).
    const patientName = cells.find((c) => /^[A-Za-z'’.\- ]+,\s*[A-Za-z]/.test(c) && !/M\.?D\.?/.test(c)) ?? "";
    // Order STATUS column — match the value exactly so we don't pick up the
    // "Abnormal"/"Normal" result-flag cell (col 0). "Complete" = finalized.
    const status =
      cells.find((c) => /^(complete|in[\s-]?process|pending|preliminary|final|received|partial|cancell?ed)$/i.test(c.trim())) ?? "";
    out.push({ orderId, patientName, status });
  }
  return out;
}

function isReady(row: RowSnapshot): boolean {
  // "Complete" is the finalized signal in the inbox status column.
  return /complete/i.test(row.status);
}

function matchRow(c: OpenCase, rows: RowSnapshot[]): RowSnapshot | null {
  if (c.labExternalRef) {
    const byRef = rows.find((r) => r.orderId.trim() === c.labExternalRef!.trim());
    if (byRef) return byRef;
  }
  const nameNorm = normalizeName(c.patientName);
  return rows.find((r) => normalizeName(r.patientName) === nameNorm) ?? null;
}

// Open one report and capture the PDF. Validated sequence (the slow site needs
// patience): activate the row by clicking the patient name, check its box, click
// "Print Selected". When the report finishes loading (~5-20s) it AUTO-fires a
// browser download of the report PDF; we capture that. Fallback: click the
// "Download" button that also appears inside iframe[name="reportWindow"].
async function openReportAndCapture(
  page: Page,
  row: RowSnapshot,
): Promise<{ buf: Buffer; filename: string } | null> {
  const orderLink = page.locator(ORDER_LINK_SEL, { hasText: row.orderId }).first();
  if ((await orderLink.count()) === 0) return null;
  const tr = orderLink.locator("xpath=ancestor::tr[1]");
  const checkbox = tr.locator(ROW_CHECKBOX_SEL).first();
  if ((await checkbox.count()) === 0) return null;

  // Activate the row first (Print Selected is a no-op without this), then select.
  await tr.getByText(row.patientName, { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await checkbox.check();
  await page.waitForTimeout(600);

  // Arm the download listener BEFORE triggering. Generous timeout for the slow load.
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("button", { name: "Print Selected", exact: true }).click();

  // The report auto-downloads when it finishes loading. As a belt-and-suspenders
  // fallback, also click the iframe Download button if it appears first.
  page
    .frameLocator('iframe[name="reportWindow"]')
    .getByRole("button", { name: /download/i })
    .click({ timeout: 60_000 })
    .catch(() => {});

  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error(`download produced no file for ${row.orderId}`);
  const buf = await readFile(path);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`downloaded file for ${row.orderId} was not a PDF`);
  }

  // suggestedFilename is an opaque session token; build a meaningful name.
  const safePatient = row.patientName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const filename = `spectracell_${safePatient}_${row.orderId}.pdf`;

  await dismissReport(page);
  await checkbox.uncheck().catch(() => {});
  return { buf, filename };
}

// Close the report popup/overlay so the next case starts from a clean inbox.
async function dismissReport(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "Close", exact: true });
  if (await close.count().then((n) => n > 0).catch(() => false)) {
    await close.first().click().catch(() => {});
  } else {
    await page.locator(".ui-widget-overlay").click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
}

function normalizeName(s: string): string {
  // "Centner, David" / "David Centner" / "CENTNER, DAVID" → "centner david"
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}
