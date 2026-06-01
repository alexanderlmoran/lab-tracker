// POC runner for the agentic browser scraper. Drives a real portal with the
// LLM agent and reports what it captured — WITHOUT touching the tracker
// pipeline (dry-run: the PDF is saved to /tmp, never POSTed to result-ready).
//
// Usage (Cyrex POC):
//   cd worker
//   PATIENT="Leila Centner" ACCESSION=123456 DOB=1976-12-28 \
//     npx tsx scripts/agent-fetch.ts
//
// Flags / env:
//   LAB=cyrex            which portal (default cyrex)
//   PATIENT=...          patient full name to find (required unless FROM_TRACKER=1)
//   ACCESSION=...        order/accession # (optional; agent falls back to name)
//   DOB=YYYY-MM-DD       optional, improves name matching
//   FROM_TRACKER=1       instead of a synthetic case, pull open cases for LAB
//   HEADLESS=1           run headless (default: headed so you can watch)
//   APPLY=1              POST the captured PDF to /api/worker/result-ready
//                        (otherwise dry-run: save to /tmp only)

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import type { OpenCase } from "../src/tracker-client.js";
import type { LabScraper } from "../src/scrapers/base.js";
import { cyrexScraper } from "../src/scrapers/agentic.js";

loadEnvLocal();

const SCRAPERS: Record<string, LabScraper> = { cyrex: cyrexScraper };

const LAB = (process.env.LAB ?? "cyrex").toLowerCase();
const HEADLESS = process.env.HEADLESS === "1";
const APPLY = process.env.APPLY === "1";

const log = (m = "") => console.log(m);

async function buildCases(): Promise<OpenCase[]> {
  const scraper = SCRAPERS[LAB];
  const patient = process.env.PATIENT;
  if (!patient) throw new Error("PATIENT is required (or set FROM_TRACKER=1)");
  return [
    {
      caseId: "poc-synthetic",
      patientName: patient,
      patientDob: process.env.DOB ?? null,
      patientEmail: "poc@example.com",
      labName: scraper.labName,
      labExternalRef: process.env.ACCESSION ?? null,
      sampleSentAt: null,
      trackingDeliveredAt: null,
      expectedResultAtMin: null,
      expectedResultAtMax: null,
    },
  ];
}

async function postResultReady(c: OpenCase, pdfBase64: string, filename: string, accession: string) {
  const base = process.env.TRACKER_BASE_URL;
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) throw new Error("TRACKER_BASE_URL / WORKER_SHARED_SECRET required for APPLY");
  const res = await request(`${base}/api/worker/result-ready`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      caseId: c.caseId,
      labExternalRef: accession,
      pdfBase64,
      pdfFilename: filename,
      resultIssuedAt: new Date().toISOString(),
      source: `agent:${LAB}`,
    }),
  });
  log(`  result-ready → HTTP ${res.statusCode}: ${(await res.body.text()).slice(0, 200)}`);
}

async function main() {
  const scraper = SCRAPERS[LAB];
  if (!scraper) throw new Error(`unknown LAB="${LAB}" (have: ${Object.keys(SCRAPERS).join(", ")})`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const cases = await buildCases();
  log("─".repeat(78));
  log(`AGENTIC SCRAPER POC — lab=${scraper.labName}  mode=${APPLY ? "APPLY" : "DRY-RUN"}  headless=${HEADLESS}`);
  log(`cases: ${cases.map((c) => `${c.patientName}${c.labExternalRef ? ` / ${c.labExternalRef}` : ""}`).join("; ")}`);
  log("─".repeat(78));

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const run = await scraper.run(browser, cases);
    log();
    log(`FOUND: ${run.found.length}   ERRORS: ${run.errors.length}`);
    for (const e of run.errors) log(`  ✗ ${e.caseId.slice(0, 8)}: ${e.message}`);

    for (const r of run.found) {
      const bytes = Buffer.from(r.pdfBase64, "base64");
      const out = join(tmpdir(), r.pdfFilename);
      await writeFile(out, bytes);
      log(`  ✓ ${r.caseId.slice(0, 8)}  ${r.labExternalRef}  ${bytes.length} bytes → ${out}`);
      if (APPLY) {
        const c = cases.find((x) => x.caseId === r.caseId)!;
        await postResultReady(c, r.pdfBase64, r.pdfFilename, r.labExternalRef);
      }
    }
    if (!APPLY && run.found.length) log("\n(dry-run — PDFs saved to /tmp, nothing posted to the tracker. Set APPLY=1 to wire it in.)");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
