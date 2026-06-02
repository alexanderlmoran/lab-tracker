// Recipe engine — browser-transport strategies (Phase 2). These operate on a
// Playwright Page. Config-driven ports of the verified browser scrapers; quirks
// (password-reveal, per-case search, slow waits) are config flags.

import type { Page, Locator } from "playwright";
import type {
  BrowserAuthStrategy,
  BrowserDiscoveryStrategy,
  BrowserPdfStrategy,
  DiscoveredRow,
} from "./types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`recipe: required env var ${name} is not set`);
  return v;
}

// ---------------------------------------------------------------- auth

// Standard portal login form. cfg: {loginUrl, userSel, pwSel, pwRevealSel?,
// userEnv, passEnv, submit:{name}|sel, successSel, postLogin?:[{role,name}|{goto}],
// readySel?}. pwRevealSel handles the DNN two-field "show password" reveal (Cyrex).
const browserFormAuth: BrowserAuthStrategy = async (pageU, cfg) => {
  const page = pageU as Page;
  await page.goto(cfg.loginUrl as string, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill(cfg.userSel as string, env(cfg.userEnv as string));
  if (cfg.pwRevealSel) {
    const rev = page.locator(cfg.pwRevealSel as string);
    if (await rev.isVisible().catch(() => false)) await rev.click();
  }
  await page.fill(cfg.pwSel as string, env(cfg.passEnv as string));

  const submit = cfg.submit as { name?: string; sel?: string };
  const clickSubmit = submit.sel
    ? page.locator(submit.sel).first().click()
    : page.getByRole("button", { name: new RegExp(submit.name ?? "sign in", "i") }).first().click();
  await Promise.all([page.waitForLoadState("domcontentloaded"), clickSubmit]);

  if (cfg.successSel) await page.waitForSelector(cfg.successSel as string, { timeout: 30_000 });

  for (const step of (cfg.postLogin as Array<Record<string, string>>) ?? []) {
    if (step.goto) {
      await page.goto(step.goto, { waitUntil: "domcontentloaded" });
    } else if (step.name) {
      const link = page.getByRole((step.role as "link") ?? "link", { name: step.name }).first();
      await Promise.all([page.waitForLoadState("domcontentloaded"), link.click()]).catch(() => {});
    }
  }
  if (cfg.readySel) await page.waitForSelector(cfg.readySel as string, { timeout: 30_000 });
};

// ---------------------------------------------------------------- discovery

// Read every cell text of a row's <td>s, then map by column index.
async function readRowCells(tr: Locator): Promise<string[]> {
  const tds = tr.locator(":scope > td");
  const n = await tds.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(((await tds.nth(i).textContent()) ?? "").replace(/\s+/g, " ").trim());
  return out;
}

function mapBrowserRow(cells: string[], colMap: Record<string, number>, hasResult: boolean): DiscoveredRow {
  const cell = (k: string) => (colMap[k] != null ? cells[colMap[k]] : undefined);
  const last = cell("lastName");
  const first = cell("firstName");
  const name = cell("name") ?? (last || first ? `${last ?? ""}, ${first ?? ""}`.trim() : undefined);
  return {
    ref: cell("ref"),
    name,
    dob: cell("dob"),
    // When a result-link gates readiness (resultLinkSel set), a row with no link
    // reports empty status so it fails the ready check; otherwise use the status cell.
    status: hasResult ? cell("status") ?? "ready" : "",
    pdfRef: cell("ref"),
    raw: { cells, hasResult },
  };
}

// Per-case search grid (e.g. Cyrex RadGrid). cfg: {search:{refField, nameField,
// button:{name}, refLooksLike}, postUrlIncludes?, rowsSel, colMap, resultLinkSel, settleMs?}.
const domSearchDiscovery: BrowserDiscoveryStrategy = async (pageU, cfg, term) => {
  const page = pageU as Page;
  if (!term) return [];
  const search = cfg.search as { refField: string; nameField: string; button: { name: string }; refLooksLike?: string };
  const isRef = search.refLooksLike ? new RegExp(search.refLooksLike).test(term) : false;

  await page.fill(search.refField, "").catch(() => {});
  await page.fill(search.nameField, "").catch(() => {});
  await page.fill(isRef ? search.refField : search.nameField, term);

  const postback = cfg.postUrlIncludes
    ? page.waitForResponse((r) => r.url().includes(cfg.postUrlIncludes as string) && r.request().method() === "POST", { timeout: 30_000 }).catch(() => null)
    : Promise.resolve(null);
  await page.getByRole("button", { name: search.button.name }).first().click();
  await postback;
  await page.waitForSelector(cfg.rowsSel as string, { state: "attached", timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(Number(cfg.settleMs ?? 300));

  return readGridRows(page, cfg);
};

// Read-all inbox grid (no search). cfg: {rowsSel, colMap, resultLinkSel?, dedupeByRef?}.
const domInboxDiscovery: BrowserDiscoveryStrategy = async (pageU, cfg) => {
  const page = pageU as Page;
  await page.waitForSelector(cfg.rowsSel as string, { state: "visible", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(Number(cfg.settleMs ?? 800));
  return readGridRows(page, cfg);
};

async function readGridRows(page: Page, cfg: Record<string, unknown>): Promise<DiscoveredRow[]> {
  const rows = await page.locator(cfg.rowsSel as string).all();
  const colMap = cfg.colMap as Record<string, number>;
  const resultLinkSel = cfg.resultLinkSel as string | undefined;
  const seen = new Set<string>();
  const out: DiscoveredRow[] = [];
  for (const tr of rows) {
    const cells = await readRowCells(tr);
    const hasResult = resultLinkSel ? (await tr.locator(resultLinkSel).count()) > 0 : true;
    const row = mapBrowserRow(cells, colMap, hasResult);
    if (cfg.dedupeByRef && row.ref) {
      if (seen.has(row.ref)) continue;
      seen.add(row.ref);
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- pdf

// Locate the row by ref, click its report link, capture the browser download.
// cfg: {rowsSel, resultLinkSel, preClick?:[selectors], filenamePrefix?}.
const browserDownloadPdf: BrowserPdfStrategy = async (pageU, cfg, row) => {
  const page = pageU as Page;
  const tr = page.locator(cfg.rowsSel as string).filter({ hasText: row.ref ?? "" }).first();
  if ((await tr.count()) === 0) throw new Error(`browser-download: no row for ${row.ref}`);

  // Optional pre-clicks within the row (e.g. activate row / check a box) for portals
  // like SpectraCell. Selectors prefixed "@row " resolve inside the row.
  for (const sel of (cfg.preClick as string[]) ?? []) {
    const loc = sel.startsWith("@row ") ? tr.locator(sel.slice(5)) : page.locator(sel);
    await loc.first().click().catch(() => {});
    await page.waitForTimeout(400);
  }

  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  let trigger: Locator;
  if (cfg.triggerRole) {
    const t = cfg.triggerRole as { role: "button" | "link"; name: string };
    trigger = page.getByRole(t.role, { name: t.name, exact: true }).first(); // page-level (e.g. "Print Selected")
  } else if (cfg.triggerSel) {
    trigger = page.locator(cfg.triggerSel as string).first();
  } else {
    trigger = tr.locator(cfg.resultLinkSel as string).first(); // in-row link (e.g. Cyrex "Results")
  }
  await trigger.click();

  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error(`browser-download: no file for ${row.ref}`);
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`browser-download: not a PDF for ${row.ref}`);
  return buf;
};

// ---------------------------------------------------------------- registries

export const BROWSER_AUTH_STRATEGIES: Record<string, BrowserAuthStrategy> = {
  "browser-form": browserFormAuth,
};
export const BROWSER_DISCOVERY_STRATEGIES: Record<string, BrowserDiscoveryStrategy> = {
  "dom-search": domSearchDiscovery,
  "dom-inbox": domInboxDiscovery,
};
export const BROWSER_PDF_STRATEGIES: Record<string, BrowserPdfStrategy> = {
  "browser-download": browserDownloadPdf,
};
