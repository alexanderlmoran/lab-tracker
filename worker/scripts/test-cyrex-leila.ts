// One-off end-to-end test: log into Cyrex Labs, search Leila Centner's order by
// requisition #, download the report PDF to ~/Desktop/leila-cyrex/.
//
// Self-contained — does NOT depend on the tracker API or worker infra. If this
// works, the cyrex.ts scraper logic is sound. If it fails, the error + the
// auto-screenshots tell us exactly which selector/assumption is wrong.
//
// Run:
//   cd worker
//   npx playwright install chromium    # one time
//   CYREX_USERNAME=... CYREX_PASSWORD=... npx tsx scripts/test-cyrex-leila.ts
//   # (creds are already in worker/.env.local — `set -a; . .env.local; set +a` to load)
//
// Browser opens visibly (headless: false) so you can watch. HEADLESS=1 hides it.

import { chromium, type Page } from "playwright";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const LOGIN_URL = "https://www.cyrexlabs.com/Home/tabid/40/Default.aspx";
const TARGET_REQUISITION = "T05250612"; // Leila Centner — Lymphocyte MAP, 5/14/2025
const TARGET_LAST = "CENTNER";
const OUTPUT_DIR = join(homedir(), "Desktop", "leila-cyrex");

const USERNAME = process.env.CYREX_USERNAME;
const PASSWORD = process.env.CYREX_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("Set CYREX_USERNAME and CYREX_PASSWORD env vars before running.");
  process.exit(1);
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  log(`output dir: ${OUTPUT_DIR}`);

  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    log("navigating to Cyrex home…");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    log("filling login form…");
    const userField = page.locator("input[id$='_txtUsername']");
    if (!(await userField.isVisible().catch(() => false))) {
      await page.getByRole("link", { name: /log\s*in|sign\s*in/i }).first().click().catch(() => {});
    }
    await page.fill("input[id$='_txtUsername']", USERNAME!);
    // DNN hides the real password field until its plaintext placeholder
    // sibling (txtPasswordView) is focused — click it first to reveal txtPassword.
    const pwView = page.locator("input[id$='_txtPasswordView']");
    if (await pwView.isVisible().catch(() => false)) {
      await pwView.click();
    }
    await page.fill("input[id$='_txtPassword']", PASSWORD!);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.getByRole("button", { name: /login|sign in/i }).first().click(),
    ]);
    await page.waitForSelector("a:has-text('My Orders')", { timeout: 20_000 });
    log("logged in.");

    log("opening My Orders…");
    const ordersLink = page.getByRole("link", { name: "My Orders" }).first();
    if (await ordersLink.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), ordersLink.click()]);
    } else {
      await page.goto("https://www.cyrexlabs.com/MyOrders/tabid/80/Default.aspx", {
        waitUntil: "domcontentloaded",
      });
    }
    await page.waitForSelector("input[id$='_txtRequisitionId']", { timeout: 20_000 });

    log(`searching requisition ${TARGET_REQUISITION}…`);
    await page.fill("input[id$='_txtRequisitionId']", TARGET_REQUISITION);
    const postback = page
      .waitForResponse(
        (r) => r.url().includes("/MyOrders/") && r.request().method() === "POST",
        { timeout: 30_000 },
      )
      .catch(() => null);
    await page.getByRole("button", { name: "Search" }).first().click();
    await postback;
    const ROWS_SEL = "div[id$='_grdOrders'] tr.rgRow, div[id$='_grdOrders'] tr.rgAltRow";
    await page.waitForSelector(ROWS_SEL, { state: "attached", timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(300);

    // Read the matching row(s).
    const rowLoc = page.locator(ROWS_SEL);
    const rows = await rowLoc.all();
    log(`grid returned ${rows.length} row(s).`);
    let target: ReturnType<typeof page.locator> | null = null;
    for (const tr of rows) {
      const tds = tr.locator(":scope > td");
      const cell = async (i: number) => ((await tds.nth(i).textContent()) ?? "").trim();
      const req = await cell(6);
      const last = await cell(1);
      const first = await cell(2);
      const test = await cell(3);
      const status = await cell(10);
      const hasResult =
        (await tr.locator("a[id$='_lnkResult'], a:has-text('Results')").count()) > 0;
      log(
        `  row: last=${last} first=${first} req=${req} status=${status} resultLink=${hasResult} test="${test.slice(0, 40)}"`,
      );
      if (req === TARGET_REQUISITION && hasResult) {
        target = tr;
      }
    }

    if (!target) {
      log("no ready row matched the target requisition — exiting.");
      process.exitCode = 1;
      return;
    }

    log("clicking Results → expecting a download…");
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await target.locator("a[id$='_lnkResult'], a:has-text('Results')").first().click();
    const download = await downloadPromise;

    const suggested = download.suggestedFilename();
    const path = await download.path();
    if (!path) throw new Error("download produced no file path");
    const buf = await readFile(path);
    const dest = join(OUTPUT_DIR, suggested || `cyrex_${TARGET_REQUISITION}.pdf`);
    await writeFile(dest, buf);

    // ---- verification bar (per skill Step 5) ----
    const head = buf.subarray(0, 5).toString("latin1");
    const md5 = createHash("md5").update(buf).digest("hex");
    const isPdf = head === "%PDF-";
    const nameOk = suggested.toUpperCase().includes(TARGET_LAST);
    log(`saved → ${dest}`);
    log(`  bytes=${buf.length}  md5=${md5}`);
    log(`  magic="${head}" ${isPdf ? "✓ valid PDF" : "✗ NOT a PDF"}`);
    log(`  filename "${suggested}" ${nameOk ? "✓ contains " + TARGET_LAST : "✗ missing patient name"}`);

    await writeFile(
      `${dest}.meta.json`,
      JSON.stringify(
        {
          requisition: TARGET_REQUISITION,
          suggestedFilename: suggested,
          bytes: buf.length,
          md5,
          validPdf: isPdf,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    if (!isPdf || !nameOk) {
      log("VERIFICATION FAILED.");
      process.exitCode = 1;
    } else {
      log("VERIFICATION PASSED.");
    }
  } catch (err) {
    console.error("FAILED:", err);
    try {
      const pages = ctx.pages();
      for (let i = 0; i < pages.length; i++) {
        const dest = join(OUTPUT_DIR, `failure_${Date.now()}_page${i}.png`);
        await pages[i].screenshot({ path: dest, fullPage: true });
        log(`screenshot saved: ${dest}  (url: ${pages[i].url()})`);
      }
    } catch (screenshotErr) {
      console.error("screenshot failed:", screenshotErr);
    }
    if (process.env.HEADLESS !== "1") {
      log("leaving browser open 30s for inspection…");
      await page.waitForTimeout(30_000);
    }
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main();
