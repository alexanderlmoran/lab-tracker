// Headless Zenoti auto-login. Replaces manual storage.json capture: logs in with
// ZENOTI_USERNAME/PASSWORD and writes a fresh Playwright storageState the sync can
// read (loadCookieHeader). Flow (from the codegen capture): the tenant URL
// redirects to the ids-az login; fill username/password; Login → OAuth callback →
// back to the tenant app (#menuLinkapptBook present == logged in).
//
// Risk being tested: Zenoti "machine authentication" may challenge a new device
// (no #menuLinkapptBook → timeout). If that happens we need a trusted-device path.
//
// Run: ZENOTI_STORAGE_PATH=/tmp/z.json npx tsx scripts/zenoti-login.ts

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const U = process.env.ZENOTI_USERNAME;
const P = process.env.ZENOTI_PASSWORD;
const TENANT = process.env.ZENOTI_TENANT_URL ?? "https://centnerwellness.zenoti.com/";
const OUT = process.env.ZENOTI_STORAGE_PATH ?? "captures/zenoti/auto/storage.json";

if (!U || !P) throw new Error("ZENOTI_USERNAME / ZENOTI_PASSWORD required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

// Zenoti shows an "upgrade your browser" interstitial to the default headless UA
// (no login form), so present a current desktop-Chrome UA.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    log(`goto ${TENANT} (→ ids-az login)`);
    await page.goto(TENANT, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.getByRole("textbox", { name: "Username" }).fill(U!);
    await page.getByRole("textbox", { name: "Password" }).fill(P!);
    await page.getByRole("button", { name: "Login" }).click();

    log("submitted creds; waiting for the app to load (#menuLinkapptBook)…");
    await page.waitForSelector("#menuLinkapptBook", { timeout: 60_000 });

    const state = await ctx.storageState();
    const zCookies = state.cookies.filter((c) => /zenoti\.com$/.test(c.domain ?? "")).length;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(state));
    log(`LOGIN OK — ${state.cookies.length} cookies (${zCookies} zenoti) → ${OUT}`);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  log(`LOGIN FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
