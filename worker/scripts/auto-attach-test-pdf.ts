// TEST-MODE ONLY: drop-in replacement for the production Access scraper.
//
// Polls /api/worker/cases-awaiting-pdf every few seconds. Whenever a case
// hits the "PDF expected" state (step4 done + accession entered, no PDF
// attached yet), this script attaches a canned test PDF to it via
// /api/worker/result-ready — same path the real Access scraper would take.
//
// Production note: DELETE this script before deploy. The real scrapers
// (worker/src/scrapers/*.ts) do the real work against real lab portals.
//
// Run (no env needed — auto-loads from .env.local):
//   npx tsx scripts/auto-attach-test-pdf.ts
//   AUTO_ATTACH_INTERVAL_MS=3000 npx tsx scripts/auto-attach-test-pdf.ts

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const INTERVAL_MS = Number(process.env.AUTO_ATTACH_INTERVAL_MS ?? "5000");
const TEST_PDF_PATH = join(homedir(), "Desktop/leila/access_007138032.pdf");

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

type AwaitingCase = {
  caseId: string;
  labName: string;
  patientName: string;
  patientDob: string | null;
  collectionDate: string | null;
  labExternalRef: string;
};

let cachedBase64: string | null = null;
let cachedFilename: string | null = null;

async function loadTestPdf(): Promise<{ base64: string; filename: string }> {
  if (cachedBase64 && cachedFilename)
    return { base64: cachedBase64, filename: cachedFilename };
  const bytes = await readFile(TEST_PDF_PATH);
  cachedBase64 = bytes.toString("base64");
  cachedFilename = basename(TEST_PDF_PATH);
  log(`loaded test PDF: ${TEST_PDF_PATH} (${bytes.length} bytes)`);
  return { base64: cachedBase64, filename: cachedFilename };
}

async function listAwaitingCases(): Promise<AwaitingCase[]> {
  const res = await request(`${BASE}/api/worker/cases-awaiting-pdf`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`awaiting-pdf ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as { ok: boolean; cases: AwaitingCase[]; error?: string };
  if (!json.ok) throw new Error(json.error ?? "awaiting-pdf returned ok=false");
  return json.cases;
}

async function attachPdf(c: AwaitingCase) {
  const { base64, filename } = await loadTestPdf();
  const res = await request(`${BASE}/api/worker/result-ready`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      caseId: c.caseId,
      labExternalRef: c.labExternalRef,
      pdfBase64: base64,
      pdfFilename: filename,
      resultIssuedAt: new Date().toISOString(),
      source: "scraper:access (test-mode auto-attach)",
    }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`result-ready ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  log(`attached → case=${c.caseId} patient=${c.patientName} acc=${c.labExternalRef}`);
}

async function tick(): Promise<number> {
  try {
    const cases = await listAwaitingCases();
    for (const c of cases) {
      try {
        await attachPdf(c);
      } catch (err) {
        log(
          `FAIL attaching case=${c.caseId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return cases.length;
  } catch (err) {
    log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function main() {
  log(`auto-attach watcher starting`);
  log(`  tracker:  ${BASE}`);
  log(`  test pdf: ${TEST_PDF_PATH}`);
  log(`  polling every ${INTERVAL_MS}ms (Ctrl+C to stop)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
