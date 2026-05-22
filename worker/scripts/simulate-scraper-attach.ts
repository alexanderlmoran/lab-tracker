// E2E test helper — simulates a lab portal scraper attaching a result PDF
// to an existing tracker case. Reads a PDF from disk, base64s it, and POSTs
// to /api/worker/result-ready. After this runs, the case moves to the
// "Pending Upload" column in the UI.
//
// Run:
//   cd worker
//   CASE_ID=<uuid> \
//   PDF_PATH=~/Desktop/leila/access_007138032.pdf \
//   ACCESSION=007138032 \
//   SOURCE=scraper:access \
//     npx tsx scripts/simulate-scraper-attach.ts

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { homedir } from "node:os";
import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const CASE_ID = process.env.CASE_ID;
const PDF_PATH = process.env.PDF_PATH;
const ACCESSION = process.env.ACCESSION ?? "TEST-0001";
const SOURCE = process.env.SOURCE ?? "scraper:test";

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");
if (!CASE_ID) throw new Error("CASE_ID is required");
if (!PDF_PATH) throw new Error("PDF_PATH is required");

const resolvedPath = PDF_PATH.startsWith("~/")
  ? PDF_PATH.replace(/^~\//, `${homedir()}/`)
  : PDF_PATH;

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  log(`reading ${resolvedPath}`);
  const bytes = await readFile(resolvedPath);
  const pdfBase64 = bytes.toString("base64");
  log(`  ${bytes.length} bytes → base64 ${pdfBase64.length} chars`);

  log(`POST → ${BASE}/api/worker/result-ready`);
  log(`  case=${CASE_ID} accession=${ACCESSION} source=${SOURCE}`);

  const res = await request(`${BASE}/api/worker/result-ready`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      caseId: CASE_ID,
      labExternalRef: ACCESSION,
      pdfBase64,
      pdfFilename: basename(resolvedPath),
      resultIssuedAt: new Date().toISOString(),
      source: SOURCE,
    }),
  });

  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`tracker rejected: ${res.statusCode} ${text.slice(0, 500)}`);
  }
  log(`OK ${text}`);
  log("");
  log("Open the tracker → the case should now be in the 'Pending Upload' column.");
  log("Click the card → review the PDF → click Approve to enqueue the PB upload.");
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
