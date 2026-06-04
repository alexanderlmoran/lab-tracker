// Debug: log into Access labgen, dump what's in #maininbox, and check whether
// Fereshteh Krasowski's results are there (hypothesis: they're NOT — they're
// ~2 months old, so they aged off the inbox and need a name SEARCH the scraper
// doesn't do). Also probes the page for a search affordance.
//   cd worker && npx tsx scripts/access-inbox-probe.ts

import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const USER = process.env.ACCESS_USERNAME;
const PASS = process.env.ACCESS_PASSWORD;
if (!USER || !PASS) throw new Error("ACCESS_USERNAME / ACCESS_PASSWORD required (.env.local)");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  try {
    await page.goto("https://access.labsvc.net/labgen/", { waitUntil: "networkidle" });
    await page.fill('input[placeholder="User ID"]', USER!);
    await page.fill('input[placeholder="Password"]', PASS!);
    await page.click("a.x-btn:has(.icon-login)");
    await page.waitForSelector("#maininbox", { timeout: 30000 });
    await page.click("#maininbox");
    await page.waitForSelector("table.x-grid-item[data-recordid]", { timeout: 30000 });
    await page.waitForTimeout(1200);

    const names = await page.$$eval("table.x-grid-item[data-recordid]", (rows) =>
      rows.map((r) => {
        const tds = r.querySelectorAll("tr > td");
        return (tds[1]?.textContent ?? "").trim();
      }),
    );
    log(`inbox rows: ${names.length}`);
    const krasowski = names.filter((n) => /krasowski/i.test(n));
    log(`Krasowski in inbox: ${krasowski.length ? JSON.stringify(krasowski) : "NONE — confirms the inbox-only gap"}`);
    log(`sample inbox names (first 12): ${JSON.stringify(names.slice(0, 12))}`);

    // What search affordances exist on the page?
    const searchHints = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input,button,a").forEach((el) => {
        const t = (el.getAttribute("placeholder") || el.getAttribute("title") || el.textContent || "").trim();
        if (/search|find|patient|name|lookup|filter|history|archive/i.test(t) && t.length < 40) out.push(`${el.tagName}:${t}`);
      });
      return [...new Set(out)].slice(0, 25);
    });
    log(`search-ish elements: ${JSON.stringify(searchHints)}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
