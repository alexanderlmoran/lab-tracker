// Exercise the Access scraper's run() Search-Reports fallback + matchSearchRow
// date-disambiguation + download-from-search, end-to-end, read-only (the PDF is
// captured into memory; nothing is posted to the tracker or PB).
//
// Uses an AGED Leila case (sampled ~01/18/2026) that won't be in the recent
// inbox, so the search fallback fires. Expect it to date-match accession
// 006675487 (collected 01/20/2026) and download a non-trivial PDF.
//   cd worker && npx tsx scripts/test-access-run-fallback.ts

import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const { accessScraper } = await import("../src/scrapers/access.js");

const aged = {
  caseId: "test-aged",
  patientName: "Leila Centner",
  patientDob: "1976-12-28",
  patientEmail: "",
  labName: "Access",
  labExternalRef: null,
  sampleSentAt: "2026-01-18T00:00:00Z",
  trackingDeliveredAt: null,
  expectedResultAtMin: null,
  expectedResultAtMax: null,
};

console.log(`run() with aged case (sampled ${aged.sampleSentAt.slice(0, 10)})…\n`);
const browser = await chromium.launch({ headless: true });
try {
  const t0 = Date.now();
  const run = await accessScraper.run(browser, [aged]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done in ${secs}s — found ${run.found.length}, errors ${run.errors.length}\n`);
  for (const f of run.found) {
    const bytes = Buffer.from(f.pdfBase64, "base64").length;
    console.log(
      `  acc=${f.labExternalRef}  final=${f.resultIssuedAt ?? "—"}  ` +
        `pdf=${(bytes / 1024).toFixed(0)}KB  file=${f.pdfFilename}`,
    );
  }
  for (const e of run.errors) console.log(`  ERROR ${e.caseId}: ${e.message}`);
  const ok = run.found[0]?.labExternalRef === "006675487";
  console.log(`\nexpected acc 006675487 (collected 01/20/2026): ${ok ? "✓ MATCH" : "✗ got " + (run.found[0]?.labExternalRef ?? "nothing")}`);
} catch (e) {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await browser.close();
}
