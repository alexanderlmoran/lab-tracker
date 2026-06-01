// Backfill Brain — preview run, Leila Centner only.
//
// Reports what the backfill would do without doing anything. NO mutations
// to lab_cases. NO emails. NO PB writes. Just classification.
//
// Run:
//   cd worker
//   npx tsx scripts/backfill-leila-preview.ts
//
// What it does:
//   1. PB login (uses PB_USERNAME / PB_PASSWORD from .env.local)
//   2. Find Leila on PB (Centner, 1976-12-28)
//   3. Pull all her PB labrequests
//   4. Pull all her tracker cases that are stuck at Sample Sent (step1=true,
//      step5=false, not deleted, not archived)
//   5. Run each case through the backfill engine
//   6. Print a per-case report grouped by action bucket
//
// The next script — backfill-leila-execute.ts — will be built AFTER you
// approve this preview. It will silently advance step5 on the
// "already-on-pb" cases with confidence=high. Email/Nadia/Allison
// triggers are bypassed entirely (direct DB UPDATE, not setStepCompleted).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import {
  pbLogin,
  findPbPatient,
  listAllConsultantLabRequests,
} from "../src/uploaders/practicebetter.js";
import {
  classifyCase,
  type BackfillCase,
  type BackfillDecision,
} from "../src/backfill/engine.js";

loadEnvLocal();

// ── Shipping CSV lookup (for panel-hint matching) ──────────────────────────
//
// Tracker rows store generic lab_name ("Custom", "Other"); the shipping CSV
// has the actual panel name ("vaginal microbiome", "telomere", etc.) which
// often appears in the PB labrequest title. We index by tracking_number and
// hand the contents string to the engine as panelHint.

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normTracking(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

function loadContentsByTracking(): Map<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const path = resolve(repoRoot, "Lab Shipping - Main.csv");
  const all = parseCsv(readFileSync(path, "utf-8"));
  if (all.length === 0) return new Map();
  const header = all[0].map((h) => h.trim().toLowerCase());
  const trackingIdx = header.findIndex((h) => h.replace(/\s+/g, "").startsWith("tracking#"));
  const contentsIdx = header.indexOf("contents");
  const out = new Map<string, string>();
  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    if (!r) continue;
    const t = (r[trackingIdx] ?? "").trim();
    const c = (r[contentsIdx] ?? "").trim();
    if (!t) continue;
    // First win — if a tracking# appears twice we don't care about later rows.
    if (!out.has(normTracking(t)) && c) out.set(normTracking(t), c);
  }
  return out;
}

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;

if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");
if (!PB_USERNAME || !PB_PASSWORD)
  throw new Error("PB_USERNAME / PB_PASSWORD are required");

const log = (m: string) => console.log(m);

// Pull Leila's tracker cases via the debug endpoint. We filter
// client-side for the precise step combination we need.
type TrackerCase = {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  lab_name: string;
  collection_date: string | null;
  lab_external_ref: string | null;
  tracking_number: string | null;
  zenoti_appointment_id: string | null;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step3_partial_uploaded: boolean;
  step4_complete_received: boolean;
  step5_complete_uploaded: boolean;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
};

async function fetchLeilaCases(): Promise<TrackerCase[]> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?q=leila&deleted=null`;
  const res = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(`tracker debug ${res.statusCode}`);
  }
  const json = (await res.body.json()) as { ok: boolean; cases: TrackerCase[] };
  return (json.cases ?? []).filter(
    (c) =>
      c.step1_sample_sent &&
      !c.step5_complete_uploaded &&
      !c.archived_at,
  );
}

function toBackfillCase(c: TrackerCase, contentsByTracking: Map<string, string>): BackfillCase {
  const hint = c.tracking_number
    ? contentsByTracking.get(normTracking(c.tracking_number)) ?? null
    : null;
  return {
    caseId: c.id,
    patientName: c.patient_name,
    patientDob: c.patient_dob,
    labName: c.lab_name,
    collectionDate: c.collection_date,
    createdAt: c.created_at,
    zenotiAppointmentId: c.zenoti_appointment_id,
    labExternalRef: c.lab_external_ref,
    panelHint: hint,
    step1: c.step1_sample_sent,
    step2: c.step2_partial_received,
    step3: c.step3_partial_uploaded,
    step4: c.step4_complete_received,
    step5: c.step5_complete_uploaded,
  };
}

async function main() {
  log("─".repeat(70));
  log("BACKFILL BRAIN — preview run (no mutations)");
  log("─".repeat(70));

  log("→ Logging in to PB…");
  const session = await pbLogin(PB_USERNAME!, PB_PASSWORD!);

  log("→ Finding Leila on PB…");
  const patient = await findPbPatient(session, "Leila Centner", "1976-12-28");
  if (!patient) {
    log("✗ Leila Centner not found on PB. Bailing.");
    process.exit(1);
  }
  log(
    `  ✓ pb_patient_id=${patient.id} firstName="${patient.firstName}" lastName="${patient.lastName}" dob=${patient.dayOfBirth}`,
  );

  log("→ Pulling ALL consultant labrequests (records= filter is broken; 2026-05-26)…");
  const allLabRequests = await listAllConsultantLabRequests(session, {
    limit: 2000,
  });
  const pbReqs = allLabRequests.filter(
    (lr) => lr.clientRecord?.id === patient.id,
  );
  log(
    `  ✓ ${allLabRequests.length} labrequest(s) consultant-wide; ${pbReqs.length} matched to Leila by clientRecord.id`,
  );
  if (pbReqs.length > 0) {
    for (const lr of pbReqs.slice(0, 5)) {
      log(`    • ${lr.id} "${lr.name}" ordered=${(lr.dateOrdered ?? "").slice(0, 10)}`);
    }
    if (pbReqs.length > 5) log(`    … and ${pbReqs.length - 5} more`);
  }

  log("→ Pulling Leila's tracker cases (step1=true, step5=false, active)…");
  const trackerCases = await fetchLeilaCases();
  log(`  ✓ ${trackerCases.length} stuck case(s) to classify`);

  if (trackerCases.length === 0) {
    log("");
    log("Nothing to backfill. Either no stuck cases for Leila, or they're already complete.");
    return;
  }

  log("→ Loading shipping CSV for panel-hint matching…");
  const contentsByTracking = loadContentsByTracking();
  log(`  ✓ ${contentsByTracking.size} tracking#→contents pairs loaded`);

  log("");
  log("─".repeat(70));
  log("CLASSIFICATION");
  log("─".repeat(70));

  const decisions: BackfillDecision[] = [];
  for (const tc of trackerCases) {
    const decision = classifyCase(toBackfillCase(tc, contentsByTracking), pbReqs);
    decisions.push(decision);
  }

  const buckets: Record<string, BackfillDecision[]> = {
    "already-on-pb": [],
    "scrape-needed": [],
    "needs-review": [],
    "leave": [],
  };
  for (const d of decisions) buckets[d.action].push(d);

  for (const [bucket, list] of Object.entries(buckets)) {
    if (list.length === 0) continue;
    log("");
    log(`▶ ${bucket}  (${list.length} cases)`);
    for (const d of list) {
      const tc = trackerCases.find((c) => c.id === d.caseId)!;
      const hint = tc.tracking_number
        ? contentsByTracking.get(normTracking(tc.tracking_number)) ?? null
        : null;
      log(
        `  • case=${d.caseId.slice(0, 8)} lab="${tc.lab_name}" collected=${tc.collection_date ?? "—"} acc=${tc.lab_external_ref ?? "—"}${hint ? ` hint="${hint}"` : ""}`,
      );
      log(`    ${d.reason}`);
      if (d.pbLabRequest) {
        log(
          `    → pb_id=${d.pbLabRequest.id} pb_name="${d.pbLabRequest.name}" pb_date=${d.pbLabRequest.dateOrdered?.slice(0, 10)}`,
        );
      }
      log(`    confidence: ${d.confidence}`);
    }
  }

  log("");
  log("─".repeat(70));
  log("SUMMARY");
  log("─".repeat(70));
  log(`  already-on-pb:   ${buckets["already-on-pb"].length}`);
  log(`  scrape-needed:   ${buckets["scrape-needed"].length}`);
  log(`  needs-review:    ${buckets["needs-review"].length}`);
  log(`  leave (recent):  ${buckets["leave"].length}`);
  log("");
  log(
    "Auto-executable on confirmation: " +
      buckets["already-on-pb"].filter((d) => d.confidence === "high").length +
      " high-confidence advances (silent step5 flip, no emails fired).",
  );
  log("");
  log("No mutations performed. Review the report; if it looks correct,");
  log("run backfill-leila-execute.ts to apply.");
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
