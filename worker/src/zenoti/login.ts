// Headless Zenoti login → fresh Playwright storageState. Used by the manual
// scripts/zenoti-login.ts and the auto-refresh loop (scripts/zenoti-auto-loop.ts).
//
// Requires ZENOTI_USERNAME / ZENOTI_PASSWORD (+ optional ZENOTI_TENANT_URL).
// A current desktop-Chrome UA is REQUIRED — the default headless UA gets Zenoti's
// "upgrade your browser" interstitial (upgrade.html?older_version=1) instead of
// the login form. Verified working headless locally and on Fly (no machine-auth
// challenge). The tenant URL 302s to the ids-az login; fill creds → Login →
// OAuth callback → tenant app (#menuLinkapptBook present == logged in).

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Logs in and writes a fresh storageState JSON to outPath. Returns cookie count.
 * Throws on failure (e.g. login form/app never appeared). */
export async function zenotiLogin(outPath: string): Promise<number> {
  const username = process.env.ZENOTI_USERNAME;
  const password = process.env.ZENOTI_PASSWORD;
  const tenant = process.env.ZENOTI_TENANT_URL ?? "https://centnerwellness.zenoti.com/";
  if (!username || !password) {
    throw new Error("ZENOTI_USERNAME / ZENOTI_PASSWORD required");
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(tenant, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("textbox", { name: "Username" }).fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForSelector("#menuLinkapptBook", { timeout: 60_000 });
    const state = await ctx.storageState();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(state));
    return state.cookies.length;
  } finally {
    await ctx.close();
    await browser.close();
  }
}
