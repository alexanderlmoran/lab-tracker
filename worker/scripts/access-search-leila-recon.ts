// Recon: run the Access "Search Reports" flow for Leila Centner and dump the
// results-grid column layout (indexed cells per row) + the findpat.cgi traffic.
// Read-only — no DB/PB writes. Grounds the column mapping before we wire
// search into the scraper.
//   cd worker && npx tsx scripts/access-search-leila-recon.ts
//
// Optional: pass "Last,First" to search a different patient.
//   npx tsx scripts/access-search-leila-recon.ts "Krasowski,Fereshteh"

import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const USER = process.env.ACCESS_USERNAME;
const PASS = process.env.ACCESS_PASSWORD;
if (!USER || !PASS) throw new Error("ACCESS_USERNAME / ACCESS_PASSWORD required");
const log = (m: string) => console.log(m);

const who = (process.argv[2] ?? "Centner,Leila").split(",");
const LAST = (who[0] ?? "").trim().toUpperCase();
const FIRST = (who[1] ?? "").trim().toUpperCase();

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  const doneSeen: string[] = [];
  page.on("response", async (res) => {
    if (/findpat\.cgi/i.test(res.url())) {
      try {
        const t = await res.text();
        if (/"done"\s*:\s*true/i.test(t)) doneSeen.push(t.slice(0, 400));
      } catch { /* ignore */ }
    }
  });

  try {
    log(`Searching Access for LAST="${LAST}" FIRST="${FIRST}"…`);
    await page.goto("https://access.labsvc.net/labgen/", { waitUntil: "networkidle" });
    await page.fill('input[placeholder="User ID"]', USER!);
    await page.fill('input[placeholder="Password"]', PASS!);
    await page.click("a.x-btn:has(.icon-login)");
    await page.waitForSelector("#maininbox", { timeout: 30000 });

    await page.click('a:has-text("Search")');
    await page.waitForTimeout(1200);
    await page.click('a:has-text("Search Reports"), button:has-text("Search Reports")').catch(() => {});
    await page.waitForTimeout(2000);

    await page.fill("#splname-inputEl", LAST);
    if (FIRST) await page.fill("#spfname-inputEl", FIRST).catch(() => {});

    // The form submit is the lowest "Search" button on the page (below top nav).
    const btnInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a.x-btn, button"))
        .map((el, i) => ({ i, text: (el.textContent || "").trim(), top: Math.round((el as HTMLElement).getBoundingClientRect().top) }))
        .filter((b) => /search/i.test(b.text) && b.text.length < 20),
    );
    const target = btnInfo.sort((a, b) => b.top - a.top)[0];
    if (!target) throw new Error("no Search submit button found");
    await page.evaluate((idx) => {
      const el = Array.from(document.querySelectorAll("a.x-btn, button"))[idx] as HTMLElement;
      el?.click();
    }, target.i);
    log(`clicked search submit idx=${target.i} (top=${target.top})`);

    let rows = 0;
    for (let i = 0; i < 70; i++) {
      rows = await page.evaluate(() => document.querySelectorAll("table.x-grid-item[data-recordid]").length);
      if (rows > 0 || doneSeen.length > 0) break;
      await page.waitForTimeout(1000);
    }
    // settle a beat after done:true so the grid finishes rendering
    if (rows === 0 && doneSeen.length > 0) {
      await page.waitForTimeout(2500);
      rows = await page.evaluate(() => document.querySelectorAll("table.x-grid-item[data-recordid]").length);
    }

    log(`\nfindpat done:true responses: ${doneSeen.length}`);
    log(`result grid rows: ${rows}\n`);

    // Dump every row with INDEXED cells (no filtering) so we can lock columns.
    const dump = await page.$$eval("table.x-grid-item[data-recordid]", (rs) =>
      rs.map((r) => Array.from(r.querySelectorAll("tr > td")).map((td) => (td.textContent || "").trim())),
    );
    dump.forEach((cells, ri) => {
      log(`ROW ${ri}:`);
      cells.forEach((c, ci) => log(`   [${ci}] ${JSON.stringify(c)}`));
      log("");
    });
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
