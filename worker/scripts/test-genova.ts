// E2E test for the Genova (GDX) pure-HTTP session-reuse scraper. Uses the
// captured Playwright storage.json as the session (GENOVA_SESSION_PATH) and
// drives genovaScraper.run() with a synthetic case (name+DOB match, no order#).
//
// Run (creds not needed — the session cookies are in the storage.json):
//   cd worker
//   GENOVA_SESSION_PATH=captures/genova/<ts>/storage.json npx tsx scripts/test-genova.ts

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { genovaScraper } from "../src/scrapers/genova.js";
import type { OpenCase } from "../src/tracker-client.js";

const OUT = join(homedir(), "Desktop", "genova-test");
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// Verified patient from the capture (order V7160106).
const syntheticCase: OpenCase = {
  caseId: "test-genova",
  patientName: process.env.TEST_PATIENT || "Michael Kovadlo",
  patientDob: process.env.TEST_DOB || "1978-01-01",
  patientEmail: "test@example.com",
  labName: "Genova",
  labExternalRef: process.env.TEST_ORDERNO || null, // null -> name+DOB match
  sampleSentAt: null,
  trackingDeliveredAt: null,
  expectedResultAtMin: null,
  expectedResultAtMax: null,
};

async function main() {
  if (!process.env.GENOVA_SESSION_PATH) {
    console.error("Set GENOVA_SESSION_PATH to a Playwright storage.json with a live gdx.net session.");
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  // genovaScraper ignores the browser arg (pure HTTP); pass a stub.
  const run = await genovaScraper.run(undefined as never, [syntheticCase]);
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
