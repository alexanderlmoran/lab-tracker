// Cyrex Labs portal scraper.
//
// Target: https://www.cyrexlabs.com/ — a DotNetNuke (ASP.NET WebForms) site
// with a Telerik RadGrid order list under "My Orders". Captured 2026-06-01
// via lab-portal-capture; HAR + recorded.js in worker/captures/cyrex/.
//
// Two things make Cyrex different from access.ts:
//   1. There is no single inbox grid — you SEARCH (by requisition # or last
//      name) and the RadGrid returns matching orders via a RadAjax postback.
//   2. The report PDF arrives as a real browser DOWNLOAD (Content-Disposition:
//      attachment; Application/octet-stream), NOT inline in Chrome's PDF
//      viewer. So we use page.waitForEvent("download") — no network-layer
//      interception needed (unlike the access.ts +repdown trap).
//
// Identifiers (from the captured PDF filename CENTNER_LEILA_25-006894_..._LMAP.pdf):
//   - Requisition #  e.g. "T05250612"  → what you SEARCH by; stored as labExternalRef.
//   - Accession #    e.g. "25-006894"  → appears only in the PDF filename, NOT searchable.
//   - DNN control IDs (ctr438 login, ctr545 orders) are stable per skin; we
//     select by id-SUFFIX so a module-placement change can't break us.

import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "./base.js";

const LOGIN_URL = "https://www.cyrexlabs.com/Home/tabid/40/Default.aspx";
const MY_ORDERS_URL = "https://www.cyrexlabs.com/MyOrders/tabid/80/Default.aspx";
const USERNAME = process.env.CYREX_USERNAME;
const PASSWORD = process.env.CYREX_PASSWORD;

// RadGrid data rows. The grid id (..._grdOrders) sits on the outer <div
// class="RadGrid">, NOT a <table> — the master table is ..._grdOrders_ctl00.
// So scope by the div and select the rgRow/rgAltRow data rows beneath it.
const ROWS_SEL =
  "div[id$='_grdOrders'] tr.rgRow, div[id$='_grdOrders'] tr.rgAltRow";
const RESULT_LINK_SEL = "a[id$='_lnkResult'], a:has-text('Results')";

type RowSnapshot = {
  lastName: string;
  firstName: string;
  testName: string;
  collectionDate: string; // M/D/YYYY
  requisition: string; // "T0525..."
  dob: string; // M/D/YYYY
  status: string; // "OnLine" when finalized
  resultDate: string; // M/D/YYYY h:mm:ss AM/PM
  hasResultLink: boolean; // the per-row "Results" download affordance is present
};

export const cyrexScraper: LabScraper = {
  labName: "Cyrex",

  async run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!USERNAME || !PASSWORD) {
      throw new Error("CYREX_USERNAME / CYREX_PASSWORD not configured");
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    try {
      await login(page);
      await openMyOrders(page);

      for (const c of openCases) {
        try {
          // Search-per-case: requisition # if we've matched before (it's the
          // exact key), otherwise fall back to last name + DOB.
          const rows = c.labExternalRef
            ? await search(page, { requisition: c.labExternalRef })
            : await search(page, { lastName: lastNameOf(c.patientName) });

          const match = matchRow(c, rows);
          if (!match) continue;
          if (!match.hasResultLink) continue; // result not finalized yet

          const pdf = await downloadRowPdf(page, match);
          if (!pdf) continue;

          found.push({
            caseId: c.caseId,
            labExternalRef: match.requisition,
            pdfBase64: pdf.buf.toString("base64"),
            pdfFilename: pdf.filename,
            resultIssuedAt: parseDate(match.resultDate) ?? parseDate(match.collectionDate),
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
};

async function login(page: Page): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // The Account Login module renders inline on the home page. If a skin variant
  // hides it behind a Login link, click that first.
  const userField = page.locator("input[id$='_txtUsername']");
  if (!(await userField.isVisible().catch(() => false))) {
    await page
      .getByRole("link", { name: /log\s*in|sign\s*in/i })
      .first()
      .click()
      .catch(() => {});
  }

  await page.fill("input[id$='_txtUsername']", USERNAME!);

  // DNN renders the password as TWO inputs: a plaintext placeholder field
  // (txtPasswordView, type=text, holding "Enter Password") shown on load, and
  // the real masked field (txtPassword, type=password) which starts HIDDEN.
  // Focusing the view field runs JS that hides the placeholder, reveals
  // txtPassword, and focuses it — so we must click the view field first, then
  // fill the (now-visible) real field. (Matches the recorded human flow.)
  const pwView = page.locator("input[id$='_txtPasswordView']");
  if (await pwView.isVisible().catch(() => false)) {
    await pwView.click();
  }
  await page.fill("input[id$='_txtPassword']", PASSWORD!);

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.getByRole("button", { name: /login|sign in/i }).first().click(),
  ]);

  // Successful login surfaces the authenticated "My Orders" menu link.
  await page.waitForSelector("a:has-text('My Orders')", { timeout: 20_000 });
}

async function openMyOrders(page: Page): Promise<void> {
  const link = page.getByRole("link", { name: "My Orders" }).first();
  if (await link.isVisible().catch(() => false)) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), link.click()]);
  } else {
    await page.goto(MY_ORDERS_URL, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("input[id$='_txtRequisitionId']", { timeout: 20_000 });
}

// Fill one search field, submit, and wait for the RadAjax grid postback to
// settle. Clears both fields first so per-case iterations don't compound.
async function search(
  page: Page,
  by: { requisition?: string; lastName?: string },
): Promise<RowSnapshot[]> {
  await page.fill("input[id$='_txtRequisitionId']", "");
  await page.fill("input[id$='_txtLastName']", "").catch(() => {});

  if (by.requisition) {
    await page.fill("input[id$='_txtRequisitionId']", by.requisition);
  } else if (by.lastName) {
    await page.fill("input[id$='_txtLastName']", by.lastName);
  } else {
    return [];
  }

  const postback = page
    .waitForResponse(
      (r) => r.url().includes("/MyOrders/") && r.request().method() === "POST",
      { timeout: 30_000 },
    )
    .catch(() => null);
  await page.getByRole("button", { name: "Search" }).first().click();
  await postback;
  // RadGrid swaps its <tbody> in a JS callback after the delta HTTP response.
  // Wait for either a data row to appear or the empty-grid message, capped short.
  await page
    .waitForSelector(ROWS_SEL, { state: "attached", timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(250);

  return readRows(page);
}

// Column map (0-indexed <td>) confirmed from the captured grid row:
//   0 links(Requisition·Invoice·Results) | 1 last | 2 first | 3 test
//   4 collectionDate | 5 orderDate | 6 requisition | 7 dob
//   8 _ | 9 provider | 10 status | 11 payment | 12 resultDate
async function readRows(page: Page): Promise<RowSnapshot[]> {
  const rows = await page.locator(ROWS_SEL).all();
  const out: RowSnapshot[] = [];
  for (const tr of rows) {
    const tds = tr.locator(":scope > td");
    const cell = async (i: number) => ((await tds.nth(i).textContent()) ?? "").trim();
    const hasResultLink = (await tr.locator(RESULT_LINK_SEL).count()) > 0;
    out.push({
      lastName: await cell(1),
      firstName: await cell(2),
      testName: await cell(3),
      collectionDate: await cell(4),
      requisition: await cell(6),
      dob: await cell(7),
      status: await cell(10),
      resultDate: await cell(12),
      hasResultLink,
    });
  }
  return out;
}

function matchRow(c: OpenCase, rows: RowSnapshot[]): RowSnapshot | null {
  // Exact by requisition # if we've matched this case before.
  if (c.labExternalRef) {
    const byRef = rows.find((r) => r.requisition.trim() === c.labExternalRef!.trim());
    if (byRef) return byRef;
  }
  // First-time match: patient name + DOB. Cyrex splits last/first into cells.
  const dobNorm = normalizeDob(c.patientDob);
  const nameNorm = normalizeName(c.patientName);
  return (
    rows.find(
      (r) =>
        normalizeName(`${r.lastName}, ${r.firstName}`) === nameNorm &&
        (dobNorm === "" || normalizeDob(r.dob) === dobNorm),
    ) ?? null
  );
}

async function downloadRowPdf(
  page: Page,
  row: RowSnapshot,
): Promise<{ buf: Buffer; filename: string } | null> {
  // Locate the grid row by its requisition cell, then click that row's
  // "Results" link. Clicking triggers the ASP.NET postback that returns the
  // PDF as a Content-Disposition: attachment download.
  const tr = page.locator(ROWS_SEL).filter({ hasText: row.requisition }).first();
  if ((await tr.count()) === 0) return null;

  const resultsLink = tr.locator(RESULT_LINK_SEL).first();
  if ((await resultsLink.count()) === 0) return null;

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await resultsLink.click();
  const download = await downloadPromise;

  const path = await download.path();
  if (!path) throw new Error(`download produced no file for req ${row.requisition}`);
  const buf = await readFile(path);

  // suggestedFilename is the rich server name, e.g.
  // CENTNER_LEILA_25-006894_05_14_2025_1441_LMAP.pdf (carries the accession #).
  const filename = download.suggestedFilename() || `cyrex_${row.requisition}.pdf`;
  return { buf, filename };
}

function lastNameOf(patientName: string): string {
  const clean = patientName.replace(/[^a-zA-Z, ]/g, "").trim();
  if (clean.includes(",")) return clean.split(",")[0].trim();
  const parts = clean.split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : clean;
}

function normalizeName(s: string): string {
  // "Doe, Jane" / "DOE, JANE" / "Jane Doe" all → "doe jane"
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}

function normalizeDob(s: string | null): string {
  if (!s) return "";
  // Tracker stores ISO (YYYY-MM-DD); Cyrex shows M/D/YYYY (non-zero-padded).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return s.trim();
}

function parseDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // "5/14/2025" or "5/12/2025 11:54:00 AM" → ISO date (YYYY-MM-DD).
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return undefined;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}
