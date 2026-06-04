// Find the Access "Search Reports" submit + capture the search network request
// (so we can replicate it). Logs in, opens Search → Search Reports, fills last
// name + date range, clicks the form's Search button, and logs every XHR fired.
//   cd worker && npx tsx scripts/access-search-explore.ts

import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const USER = process.env.ACCESS_USERNAME;
const PASS = process.env.ACCESS_PASSWORD;
if (!USER || !PASS) throw new Error("ACCESS_USERNAME / ACCESS_PASSWORD required");
const log = (m: string) => console.log(m);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  // Capture findpat.cgi requests (full body) + their JSON responses (results).
  const calls: string[] = [];
  page.on("request", (req) => {
    if (/findpat\.cgi/i.test(req.url())) {
      calls.push(`REQ ${req.method()} ${req.url().replace(/https?:\/\/[^/]+/, "")}\n  BODY: ${req.postData() ?? ""}`);
    }
  });
  page.on("response", async (res) => {
    if (/findpat\.cgi/i.test(res.url())) {
      try {
        const t = await res.text();
        calls.push(`RESP ${res.status()} ${res.url().replace(/https?:\/\/[^/]+/, "")}\n  ${t.slice(0, 1200)}`);
      } catch {
        /* ignore */
      }
    }
  });

  try {
    await page.goto("https://access.labsvc.net/labgen/", { waitUntil: "networkidle" });
    await page.fill('input[placeholder="User ID"]', USER!);
    await page.fill('input[placeholder="Password"]', PASS!);
    await page.click("a.x-btn:has(.icon-login)");
    await page.waitForSelector("#maininbox", { timeout: 30000 });
    await page.click('a:has-text("Search")');
    await page.waitForTimeout(1200);
    await page.click('a:has-text("Search Reports"), button:has-text("Search Reports")').catch(() => {});
    await page.waitForTimeout(2000);

    // Name only (today=ALL), like Alex's manual search — no date range.
    await page.fill("#splname-inputEl", "KRASOWSKI");
    await page.fill("#spfname-inputEl", "FERESHTEH").catch(() => {});

    // Enumerate every "Search" button + its position, so we can tell the nav
    // item from the form submit.
    const btnInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a.x-btn, button"))
        .map((el, i) => ({ i, text: (el.textContent || "").trim(), top: Math.round((el as HTMLElement).getBoundingClientRect().top) }))
        .filter((b) => /search/i.test(b.text) && b.text.length < 20);
    });
    log("SEARCH buttons: " + JSON.stringify(btnInfo));

    calls.length = 0; // only care about calls AFTER we submit
    // Click the LOWEST "Search" button on the page (the form submit sits in the
    // panel, below the top nav).
    const target = btnInfo.sort((a, b) => b.top - a.top)[0];
    if (target) {
      await page.evaluate((idx) => {
        const el = Array.from(document.querySelectorAll("a.x-btn, button"))[idx] as HTMLElement;
        el?.click();
      }, target.i);
      log(`clicked search button idx=${target.i} (top=${target.top})`);
    }
    // Wait up to ~35s for the async search to finish + the grid to populate.
    let rows = 0;
    for (let i = 0; i < 70; i++) {
      rows = await page.evaluate(
        () => document.querySelectorAll("table.x-grid-item[data-recordid]").length,
      );
      if (rows > 0 || calls.some((c) => /"done":\s*true/i.test(c))) break;
      await page.waitForTimeout(1000);
    }

    log("=== findpat.cgi traffic ===\n" + calls.join("\n\n"));
    log(`\nresult grid rows: ${rows}`);
    if (rows > 0) {
      const sample = await page.$$eval("table.x-grid-item[data-recordid]", (rs) =>
        rs.slice(0, 6).map((r) =>
          Array.from(r.querySelectorAll("tr > td")).map((td) => (td.textContent || "").trim()).filter(Boolean).slice(0, 8),
        ),
      );
      sample.forEach((r) => log("  ROW " + JSON.stringify(r)));
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
