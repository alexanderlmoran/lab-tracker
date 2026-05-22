// PB upload job worker.
//
// Polls the tracker for queued PB upload jobs and processes them. The worker
// never touches the tracker DB directly — everything goes through HTTP:
//   1. POST /api/worker/pb-upload/next   → claim + hydrate one job
//   2. fetch signed URL                  → PDF bytes
//   3. uploadPdfToPb(...)                → 4-step PB flow
//   4. POST /api/worker/pb-upload/result → success or failure
//
// Run:
//   cd worker
//   npx tsx scripts/pb-upload-worker.ts            # default 30s poll
//   PB_WORKER_INTERVAL_MS=10000 npx tsx scripts/pb-upload-worker.ts
//   npx tsx scripts/pb-upload-worker.ts --once     # process one job and exit
//
// Required env:
//   TRACKER_BASE_URL          e.g. http://localhost:3000
//   WORKER_SHARED_SECRET      matches the tracker
//   PB_USERNAME / PB_PASSWORD PB consultant login
//   PB_CONSULTANT_ID          uuid the labrequest is filed under
//
// The worker writes uploaded PDFs to a temp file before handing them to
// undici — PB's upload helper expects a path on disk.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { uploadPdfToPb } from "../src/uploaders/practicebetter.js";

// Load .env.local first so PB_USERNAME / PB_PASSWORD / etc. are populated
// without the user having to paste them on the command line.
loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
const PB_CONSULTANT_ID = process.env.PB_CONSULTANT_ID;
// Default to a snappy 5s poll for local testing — feels instant after an
// Approve click. Override with PB_WORKER_INTERVAL_MS for prod (e.g. 30000).
const INTERVAL_MS = Number(process.env.PB_WORKER_INTERVAL_MS ?? "5000");

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");
if (!PB_USERNAME) throw new Error("PB_USERNAME is required");
if (!PB_PASSWORD) throw new Error("PB_PASSWORD is required");
if (!PB_CONSULTANT_ID) throw new Error("PB_CONSULTANT_ID is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

type Job = {
  id: string;
  caseId: string;
  pdfId: string;
  patientName: string;
  patientDob: string | null;
  labName: string;
  /** Verbatim Zenoti service name (e.g. "Labs - Access Custom"). Optional
   * — older cases pre-dating the migration may not have it. */
  zenotiServiceName: string | null;
  collectionDate: string | null;
  /** Accession # from the PDF (preferred) or case row. Used to build a
   * traceable PB lab title. May be null for pre-accession-edit cases. */
  accession: string | null;
  pdfFilename: string;
  pdfSignedUrl: string;
};

/** Strips the "Labs - " prefix from a Zenoti service name. The prefix is
 * an internal Centner taxonomy detail that doesn't belong in front of a
 * clinician on PB. "Labs - Access Custom" → "Access Custom". */
function cleanServiceName(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^\s*Labs\s*-\s*/i, "").trim() || null;
}

/** Compose the title shown on the PB chart. Order of preference:
 *   1. Cleaned Zenoti service name + accession  ("Access Custom · Acc# 007143558")
 *   2. Cleaned Zenoti service name only          ("Access Custom")
 *   3. lab_name + accession                      ("Access · Acc# 007143558")
 *   4. lab_name                                  ("Access")
 * Clinicians scan the chart left-to-right; richer titles let them tell
 * "Access — basic panel" from "Access — custom panel" without opening
 * the PDF. Accession # supports look-up in the source lab portal. */
function composePbLabTitle(
  labName: string,
  serviceName: string | null,
  accession: string | null,
): string {
  const cleaned = cleanServiceName(serviceName);
  const head = cleaned ?? labName;
  if (!accession) return head;
  return `${head} · Acc# ${accession}`;
}

async function claimNext(): Promise<Job | null> {
  const res = await request(`${BASE}/api/worker/pb-upload/next`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.statusCode === 204) return null;
  if (res.statusCode !== 200) {
    const t = await res.body.text();
    throw new Error(`claim failed ${res.statusCode}: ${t.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as { ok: boolean; job: Job; error?: string };
  if (!json.ok) throw new Error(json.error ?? "claim returned ok=false");
  return json.job;
}

async function reportSuccess(jobId: string, pbLabRequestId: string, pbPatientId: string) {
  await postResult({ outcome: "success", jobId, pbLabRequestId, pbPatientId });
}

async function reportFailure(jobId: string, error: string) {
  await postResult({ outcome: "failure", jobId, error });
}

async function postResult(body: unknown) {
  const res = await request(`${BASE}/api/worker/pb-upload/result`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200) {
    const t = await res.body.text();
    throw new Error(`result failed ${res.statusCode}: ${t.slice(0, 200)}`);
  }
}

async function downloadToTemp(url: string, filename: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pb-upload-"));
  const path = join(dir, filename || "lab-report.pdf");
  const res = await request(url);
  if (res.statusCode !== 200) {
    throw new Error(`pdf download failed ${res.statusCode}`);
  }
  const bytes = Buffer.from(await res.body.arrayBuffer());
  await writeFile(path, bytes);
  return path;
}

async function processJob(job: Job) {
  log(`claimed job ${job.id} • case=${job.caseId} • patient=${job.patientName}`);
  let pdfPath: string | null = null;
  try {
    pdfPath = await downloadToTemp(job.pdfSignedUrl, job.pdfFilename);
    const collectionDate = job.collectionDate ?? new Date().toISOString().slice(0, 10);
    const dateOrdered = `${collectionDate}T00:00:00.000Z`;

    const result = await uploadPdfToPb({
      username: PB_USERNAME!,
      password: PB_PASSWORD!,
      consultantId: PB_CONSULTANT_ID!,
      patientName: job.patientName,
      patientDob: job.patientDob ?? undefined,
      labName: composePbLabTitle(job.labName, job.zenotiServiceName, job.accession),
      dateOrdered,
      pdfPath,
      pdfFilename: job.pdfFilename,
      isClientFacing: false,
      notify: true,
    });

    log(`uploaded → pb_labrequest=${result.labRequestId} pb_patient=${result.patientId}`);
    await reportSuccess(job.id, result.labRequestId, result.patientId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FAIL job ${job.id}: ${msg}`);
    await reportFailure(job.id, msg);
  } finally {
    if (pdfPath) {
      const parent = pdfPath.slice(0, pdfPath.lastIndexOf("/"));
      await rm(parent, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function tick(): Promise<boolean> {
  try {
    const job = await claimNext();
    if (!job) return false;
    await processJob(job);
    return true;
  } catch (err) {
    log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const once = process.argv.includes("--once");
  log(`pb-upload-worker starting`);
  log(`  tracker: ${BASE}`);
  log(`  PB user: ${PB_USERNAME}`);
  log(
    once
      ? `  mode:    --once (drain one job and exit)`
      : `  mode:    drain loop (polling every ${INTERVAL_MS}ms; Ctrl+C to stop)`,
  );

  if (once) {
    const processed = await tick();
    log(processed ? "processed 1 job, exiting" : "no jobs queued, exiting");
    return;
  }

  // Drain loop: keep ticking until empty, then sleep.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const processed = await tick();
    if (!processed) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
