// Validation for the cyrex.ts LAST-NAME-SEARCH fallback path (the branch used
// for first-time cases that don't yet have a requisition # stored).
//
// Drives the REAL cyrexScraper.run() with a synthetic OpenCase that has
// labExternalRef=null, so matching must go: search by last name -> read grid
// rows -> match by name + DOB. (Importing cyrexScraper is safe: it pulls only
// type-only imports from tracker-client, so no TRACKER_BASE_URL is required.)
//
// Run:
//   cd worker
//   CYREX_USERNAME=... CYREX_PASSWORD=... npx tsx scripts/test-cyrex-namesearch.ts

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cyrexScraper } from "../src/scrapers/cyrex.js";
import type { OpenCase } from "../src/tracker-client.js";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

const syntheticCase: OpenCase = {
  caseId: "test-leila-namesearch",
  patientName: "Leila Centner", // -> last-name search "Centner"
  patientDob: "1976-12-28", // matches grid DOB 12/28/1976
  patientEmail: "test@example.com",
  labName: "Cyrex",
  labExternalRef: null, // null -> forces the last-name search path
  sampleSentAt: null,
  trackingDeliveredAt: null,
  expectedResultAtMin: null,
  expectedResultAtMax: null,
};

async function main() {
  if (!process.env.CYREX_USERNAME || !process.env.CYREX_PASSWORD) {
    console.error("Set CYREX_USERNAME / CYREX_PASSWORD first.");
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  try {
    log("running cyrexScraper.run() with labExternalRef=null (name-search path)…");
    const run = await cyrexScraper.run(browser, [syntheticCase]);
    log(`found=${run.found.length} errors=${run.errors.length}`);
    for (const e of run.errors) log(`  ERROR ${e.caseId}: ${e.message}`);

    if (run.found.length === 0) {
      log("VERIFICATION FAILED: name-search path found no result.");
      process.exitCode = 1;
      return;
    }
    const r = run.found[0];
    const buf = Buffer.from(r.pdfBase64, "base64");
    const head = buf.subarray(0, 5).toString("latin1");
    const isPdf = head === "%PDF-";
    // Leila has multiple Cyrex orders; name-search returns them newest-first and
    // we match the first. So accept ANY valid requisition (T + digits) resolved
    // from the name+DOB match, not one specific historical one.
    const refOk = /^T\d+$/.test(r.labExternalRef);
    const nameOk = r.pdfFilename.toUpperCase().includes("CENTNER");

    const dest = join(homedir(), "Desktop", "leila-cyrex", `namesearch_${r.pdfFilename}`);
    await writeFile(dest, buf);

    log(`  labExternalRef=${r.labExternalRef} ${refOk ? "✓ (requisition resolved from name match)" : "✗ expected T05250612"}`);
    log(`  filename=${r.pdfFilename} ${nameOk ? "✓" : "✗"}`);
    log(`  bytes=${buf.length} magic="${head}" ${isPdf ? "✓ valid PDF" : "✗ NOT a PDF"}`);
    log(`  resultIssuedAt=${r.resultIssuedAt ?? "(none)"}`);
    log(`  saved -> ${dest}`);

    if (isPdf && refOk && nameOk) log("VERIFICATION PASSED: last-name fallback works.");
    else {
      log("VERIFICATION FAILED.");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
