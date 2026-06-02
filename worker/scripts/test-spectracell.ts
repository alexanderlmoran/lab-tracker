// E2E test for the SpectraCell INBOX scraper. Reads the current inbox to grab a
// real ready patient, then drives spectracellScraper.run() with a synthetic case
// for that patient (labExternalRef=null -> name match) and verifies the PDF.
//
// Run:
//   cd worker
//   set -a; . ../.env.local; set +a
//   npx tsx scripts/test-spectracell.ts
//   # or pin a patient: TEST_PATIENT="Didonato, Salvatore" npx tsx scripts/test-spectracell.ts

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spectracellScraper } from "../src/scrapers/spectracell.js";
import type { OpenCase } from "../src/tracker-client.js";

const OUT = join(homedir(), "Desktop", "leila-spectracell");
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// Discover a real ready patient from the live inbox (so the test isn't pinned to
// stale data). Override with TEST_PATIENT to force a specific name.
async function discoverPatient(): Promise<string | null> {
  if (process.env.TEST_PATIENT) return process.env.TEST_PATIENT;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(45_000);
  try {
    await page.goto("https://spec-portal.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.fill("#tUser", process.env.SPECTRACELL_USERNAME!);
    await page.fill("#tPasswd", process.env.SPECTRACELL_PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForSelector("a.orderContextMenuElement", { timeout: 45_000 });
    await page.waitForTimeout(1500);
    const link = page.locator("a.orderContextMenuElement").first();
    const row = link.locator("xpath=ancestor::tr[1]");
    const cells = (await row.locator("td").allTextContents()).map((c) => c.replace(/\s+/g, " ").trim());
    const name = cells.find((c) => /^[A-Za-z'’.\- ]+,\s*[A-Za-z]/.test(c) && !/M\.?D\.?/.test(c)) ?? null;
    return name;
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!process.env.SPECTRACELL_USERNAME || !process.env.SPECTRACELL_PASSWORD) {
    console.error("Set SPECTRACELL_USERNAME / SPECTRACELL_PASSWORD first.");
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const patient = await discoverPatient();
  if (!patient) {
    log("could not find a ready patient in the inbox — aborting.");
    process.exit(1);
  }
  log(`testing with inbox patient: "${patient}"`);

  const syntheticCase: OpenCase = {
    caseId: "test-spectracell",
    patientName: patient,
    patientDob: null,
    patientEmail: "test@example.com",
    labName: "Spectracell",
    labExternalRef: null, // force name match
    sampleSentAt: null,
    trackingDeliveredAt: null,
    expectedResultAtMin: null,
    expectedResultAtMax: null,
  };

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  try {
    const run = await spectracellScraper.run(browser, [syntheticCase]);
    log(`found=${run.found.length} errors=${run.errors.length}`);
    for (const e of run.errors) log(`  ERROR ${e.caseId}: ${e.message}`);
    if (run.found.length === 0) {
      log("VERIFICATION FAILED: no result.");
      process.exitCode = 1;
      return;
    }
    const r = run.found[0];
    const buf = Buffer.from(r.pdfBase64, "base64");
    const head = buf.subarray(0, 5).toString("latin1");
    const md5 = createHash("md5").update(buf).digest("hex");
    const isPdf = head === "%PDF-";
    const dest = join(OUT, r.pdfFilename);
    await writeFile(dest, buf);
    log(`  labExternalRef=${r.labExternalRef}`);
    log(`  filename=${r.pdfFilename}`);
    log(`  bytes=${buf.length} md5=${md5} magic="${head}" ${isPdf ? "✓ valid PDF" : "✗ NOT a PDF"}`);
    log(`  saved -> ${dest}`);
    log(isPdf ? "VERIFICATION PASSED." : "VERIFICATION FAILED.");
    if (!isPdf) process.exitCode = 1;
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
