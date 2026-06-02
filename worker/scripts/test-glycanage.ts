// E2E test for the GlycanAge pure-HTTP scraper (Firebase auto-login). Drives
// glycanageScraper.run() with a synthetic case (name match, no kit id).
//
// Run:
//   cd worker
//   set -a; . ../.env.local; set +a
//   npx tsx scripts/test-glycanage.ts
//   # or pin: TEST_PATIENT="David Centner" TEST_SAMPLE=GA-US-030967 npx tsx scripts/test-glycanage.ts

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { glycanageScraper } from "../src/scrapers/glycanage.js";
import type { OpenCase } from "../src/tracker-client.js";

const OUT = join(homedir(), "Desktop", "glycanage-test");
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const syntheticCase: OpenCase = {
  caseId: "test-glycanage",
  patientName: process.env.TEST_PATIENT || "David Centner",
  patientDob: null,
  patientEmail: "test@example.com",
  labName: "GlycanAge",
  labExternalRef: process.env.TEST_SAMPLE || null, // null -> name match
  sampleSentAt: null,
  trackingDeliveredAt: null,
  expectedResultAtMin: null,
  expectedResultAtMax: null,
};

async function main() {
  if (!process.env.GLYCANAGE_USERNAME || !process.env.GLYCANAGE_PASSWORD) {
    console.error("Set GLYCANAGE_USERNAME / GLYCANAGE_PASSWORD first.");
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const run = await glycanageScraper.run(undefined as never, [syntheticCase]);
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
  log(`  resultIssuedAt=${r.resultIssuedAt ?? "(none)"}`);
  log(`  bytes=${buf.length} md5=${md5} magic="${head}" ${isPdf ? "✓ valid PDF" : "✗ NOT a PDF"}`);
  log(`  saved -> ${dest}`);
  log(isPdf ? "VERIFICATION PASSED." : "VERIFICATION FAILED.");
  if (!isPdf) process.exitCode = 1;
}

main();
