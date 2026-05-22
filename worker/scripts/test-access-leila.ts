// One-off end-to-end test: log into Access labgen, find Leila Centner's recent
// labs, download the PDFs to ~/Desktop/leila/.
//
// This is intentionally self-contained — it does NOT depend on the tracker API
// or any worker infrastructure. If this works, the scraper logic is sound and
// we can wire up the rest of the pipeline. If it fails, the error tells us
// exactly which selector or assumption is wrong.
//
// Run:
//   cd worker
//   npm install
//   npx playwright install chromium    # one time
//   ACCESS_USERNAME=LABSCHB ACCESS_PASSWORD='Centner12$' npx tsx scripts/test-access-leila.ts
//
// The browser opens visibly (headless: false) so you can watch the first run.
// Set HEADLESS=1 to run hidden.

import { chromium, type Page } from "playwright";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ACCESS_LOGIN_URL = "https://access.labsvc.net/labgen/";
const TARGET_LAST = "CENTNER";
const TARGET_FIRST = "LEILA";
const MAX_DOWNLOADS = 3;
const OUTPUT_DIR = join(homedir(), "Desktop", "leila");

const USERNAME = process.env.ACCESS_USERNAME;
const PASSWORD = process.env.ACCESS_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("Set ACCESS_USERNAME and ACCESS_PASSWORD env vars before running.");
  process.exit(1);
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Module-level capture slot. Each call to downloadRow installs a resolver
// before clicking "Print Selected reports"; the ctx.route handler fulfills
// it as soon as the matching +repdown POST returns application/pdf. This is
// how we bypass Chrome's built-in PDF viewer extension — by the time
// response.body() would fire, the extension has replaced the body with its
// own viewer-wrapper HTML. Intercepting at the network layer gets the real
// PDF bytes before the viewer touches them.
let pendingPdfCapture:
  | { resolve: (v: { buf: Buffer; url: string }) => void; reject: (e: Error) => void }
  | null = null;

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  log(`output dir: ${OUTPUT_DIR}`);

  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ acceptDownloads: true });

  await ctx.route(
    (url) => url.toString().includes("+repdown"),
    async (route, request) => {
      if (request.method() !== "POST") {
        return route.continue();
      }
      try {
        const resp = await route.fetch();
        const body = await resp.body();
        const contentType = resp.headers()["content-type"] ?? "";
        if (contentType.includes("application/pdf") && pendingPdfCapture) {
          pendingPdfCapture.resolve({ buf: Buffer.from(body), url: request.url() });
          pendingPdfCapture = null;
        }
        await route.fulfill({ response: resp, body });
      } catch (err) {
        if (pendingPdfCapture) {
          pendingPdfCapture.reject(err as Error);
          pendingPdfCapture = null;
        }
        await route.abort().catch(() => {});
      }
    },
  );

  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept().catch(() => {}));

  try {
    log("navigating to labgen…");
    await page.goto(ACCESS_LOGIN_URL, { waitUntil: "networkidle" });

    log("filling login form…");
    await page.fill('input[placeholder="User ID"]', USERNAME!);
    await page.fill('input[placeholder="Password"]', PASSWORD!);
    await page.click("a.x-btn:has(.icon-login)");

    log("waiting for dashboard…");
    await page.waitForSelector("#maininbox", { state: "visible", timeout: 20_000 });
    log("logged in.");

    log("opening inbox…");
    await page.click("#maininbox");
    await page.waitForSelector("table.x-grid-item[data-recordid]", { timeout: 15_000 });

    // Snapshot all rows. We iterate with locators (one call per cell) rather
    // than $$eval — tsx/esbuild injects a __name helper that breaks when a
    // callback is serialized into the browser context. Slower but reliable.
    const rowHandles = await page.locator("table.x-grid-item[data-recordid]").all();
    const rows: Array<{
      recordId: string;
      name: string;
      dob: string;
      accession: string;
      collectionDate: string;
      finalDate: string;
      status: string;
    }> = [];
    for (const t of rowHandles) {
      const tds = t.locator("tr > td");
      const cell = async (i: number) => ((await tds.nth(i).textContent()) ?? "").trim();
      rows.push({
        recordId: (await t.getAttribute("data-recordid")) ?? "",
        name: await cell(1),
        dob: await cell(2),
        accession: (await cell(3)).trim(),
        collectionDate: await cell(5),
        finalDate: await cell(6),
        status: await cell(8),
      });
    }
    log(`inbox has ${rows.length} rows total.`);

    const leila = rows.filter((r) => {
      const upper = r.name.toUpperCase();
      return (
        upper.includes(TARGET_LAST) &&
        upper.includes(TARGET_FIRST) &&
        r.status.toLowerCase().includes("complete") &&
        r.finalDate.length > 0
      );
    });

    log(`found ${leila.length} ready row(s) for ${TARGET_LAST}, ${TARGET_FIRST}:`);
    for (const r of leila) {
      log(`  acc=${r.accession}  col=${r.collectionDate}  final=${r.finalDate}  status="${r.status}"`);
    }

    if (leila.length === 0) {
      log("no matching rows — exiting.");
      return;
    }

    const toDownload = leila.slice(0, MAX_DOWNLOADS);
    log(`downloading ${toDownload.length} PDF(s)…`);

    for (const r of toDownload) {
      log(`  → ${r.accession}`);
      const filename = await downloadRow(page, r.accession);
      const dest = join(OUTPUT_DIR, filename);
      log(`     saved → ${dest}`);
    }

    log("done.");
  } catch (err) {
    console.error("FAILED:", err);
    // Auto-screenshot every open page in the context so we can debug after the
    // browser closes (and so I can see them without driving Chrome myself).
    try {
      const pages = ctx.pages();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const dest = join(OUTPUT_DIR, `failure_${Date.now()}_page${i}.png`);
        await p.screenshot({ path: dest, fullPage: true });
        log(`screenshot saved: ${dest}  (url: ${p.url()})`);
      }
    } catch (screenshotErr) {
      console.error("screenshot failed:", screenshotErr);
    }
    if (process.env.HEADLESS !== "1") {
      log("leaving browser open for 30s for inspection…");
      await page.waitForTimeout(30_000);
    }
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

async function downloadRow(page: Page, accession: string): Promise<string> {
  const row = page.locator(`table.x-grid-item[data-recordid]`, {
    has: page.locator(`td:nth-child(4)`, { hasText: accession }),
  });
  if ((await row.count()) === 0) throw new Error(`no row found for acc ${accession}`);

  // Select the row.
  await row.first().locator(".x-grid-row-checker").click();

  const printBtn = page.locator('a.x-btn:has-text("Print Selected reports")').first();
  const ctx = page.context();

  // Arm the network-layer PDF capture BEFORE clicking print. The ctx.route
  // handler in main() resolves this promise with the real PDF bytes as soon
  // as the +repdown POST returns. We still wait for the popup to appear (it
  // becomes Chrome's PDF viewer rendering the captured bytes) so we can
  // close it cleanly before the next iteration.
  const capturePromise = new Promise<{ buf: Buffer; url: string }>((resolve, reject) => {
    pendingPdfCapture = { resolve, reject };
    setTimeout(() => {
      if (pendingPdfCapture) {
        pendingPdfCapture = null;
        reject(new Error(`timeout capturing PDF for acc ${accession.trim()}`));
      }
    }, 60_000);
  });

  const popupPromise = ctx.waitForEvent("page", { timeout: 60_000 });
  await printBtn.click();
  const popup = await popupPromise.catch(() => null);

  const { buf, url: pdfUrl } = await capturePromise;
  log(`     captured ${buf.length} bytes`);
  if (popup) await popup.close().catch(() => {});

  const safe = `access_${accession.trim()}.pdf`;
  const dest = join(OUTPUT_DIR, safe);
  await writeFile(dest, buf);

  // Deselect so the next iteration is clean (selecting >1 combines PDFs).
  await row.first().locator(".x-grid-row-checker").click();
  await page.waitForTimeout(500);

  await writeFile(
    `${dest}.meta.json`,
    JSON.stringify(
      { accession: accession.trim(), url: pdfUrl, downloadedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  return safe;
}

main();
