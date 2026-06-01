// Silent step5 advance for high-confidence already-on-pb cases.
//
// Re-runs the classification (same logic as backfill-leila-preview), then
// fires action=advance-step5 on each decision with action=already-on-pb
// AND confidence=high. The email cascade (Nadia + Allison) is bypassed
// because PB already has the result — staff don't need a fresh ping.
//
// Default is preview (lists what would advance). Add --apply to fire.
//   cd worker
//   npx tsx scripts/backfill-advance-highs.ts                 # Leila, preview
//   npx tsx scripts/backfill-advance-highs.ts --apply         # Leila, apply
//   npx tsx scripts/backfill-advance-highs.ts --patient=all   # everyone, preview
//
// Safety: only fires on confidence=high. The 23 already-on-pb cases
// include medium/low matches we deliberately leave for human eyeball.

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
import { classifyCase, type BackfillCase } from "../src/backfill/engine.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");
if (!PB_USERNAME || !PB_PASSWORD) throw new Error("PB_USERNAME / PB_PASSWORD required");

const argv = process.argv.slice(2);
const patientArg = argv.find((a) => a.startsWith("--patient="))?.split("=")[1] ?? "leila";
const apply = argv.includes("--apply");

const log = (m = "") => console.log(m);

// ── Shared helpers (mirror backfill-leila-preview) ─────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = ""; let row: string[] = []; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
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
    if (!t || !c) continue;
    if (!out.has(normTracking(t))) out.set(normTracking(t), c);
  }
  return out;
}

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
  created_at: string;
};

async function fetchCases(query: string): Promise<TrackerCase[]> {
  const q = query === "all" ? "" : `q=${encodeURIComponent(query)}&`;
  const url = `${TRACKER_BASE}/api/worker/debug/cases?${q}deleted=null`;
  const res = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { ok: boolean; cases: TrackerCase[] };
  return (json.cases ?? []).filter(
    (c) => c.step1_sample_sent && !c.step5_complete_uploaded && !c.archived_at,
  );
}

function toBackfillCase(c: TrackerCase, hints: Map<string, string>): BackfillCase {
  const hint = c.tracking_number ? hints.get(normTracking(c.tracking_number)) ?? null : null;
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

async function advance(id: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?id=${encodeURIComponent(id)}&action=advance-step5`;
  const res = await request(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.statusCode === 200 && !!body.ok, error: body.error };
}

async function main() {
  log("─".repeat(78));
  log(`BACKFILL ADVANCE — ${apply ? "APPLY" : "PREVIEW"}  (patient=${patientArg})`);
  log("─".repeat(78));

  const session = await pbLogin(PB_USERNAME!, PB_PASSWORD!);
  const cases = await fetchCases(patientArg);
  log(`Stuck cases (step1=true, step5=false): ${cases.length}`);

  // Group by patient so we can resolve PB labrequests once per patient.
  const byPatient = new Map<string, TrackerCase[]>();
  for (const c of cases) {
    const key = c.patient_name.trim().toLowerCase();
    const arr = byPatient.get(key) ?? [];
    arr.push(c);
    byPatient.set(key, arr);
  }

  const hints = loadContentsByTracking();
  log(`CSV hints loaded: ${hints.size}`);

  const advances: Array<{ tc: TrackerCase; reason: string; pbId: string; pbName: string }> = [];
  let skippedNoPbPatient = 0;
  let skippedNotHigh = 0;

  for (const [pname, plist] of byPatient) {
    const first = plist[0];
    const pbPatient = await findPbPatient(session, first.patient_name, first.patient_dob ?? undefined);
    if (!pbPatient) {
      log(`  ⚠ no PB record for "${first.patient_name}" — skipping ${plist.length} case(s)`);
      skippedNoPbPatient += plist.length;
      continue;
    }
    const all = await listAllConsultantLabRequests(session, { limit: 2000 });
    const pbReqs = all.filter((lr) => lr.clientRecord?.id === pbPatient.id);
    log(`  patient="${pname}" pb_id=${pbPatient.id} labrequests=${pbReqs.length}`);
    for (const tc of plist) {
      const decision = classifyCase(toBackfillCase(tc, hints), pbReqs);
      if (decision.action !== "already-on-pb" || decision.confidence !== "high") {
        skippedNotHigh++;
        continue;
      }
      advances.push({
        tc,
        reason: decision.reason,
        pbId: decision.pbLabRequest!.id,
        pbName: decision.pbLabRequest!.name,
      });
    }
  }

  log();
  log("─".repeat(78));
  log(`HIGH-CONFIDENCE ADVANCES  (${advances.length})`);
  log("─".repeat(78));
  for (const a of advances) {
    log(`  • case=${a.tc.id.slice(0, 8)}  ${a.tc.lab_name.padEnd(16)} collected=${a.tc.collection_date}`);
    log(`    PB labrequest: ${a.pbId}  "${a.pbName}"`);
  }

  log();
  log("─".repeat(78));
  log("SUMMARY");
  log("─".repeat(78));
  log(`  high-confidence advances:        ${advances.length}`);
  log(`  skipped (not high or not on PB): ${skippedNotHigh}`);
  log(`  skipped (no PB patient match):   ${skippedNoPbPatient}`);

  if (!apply) {
    log();
    log("No writes performed. Re-run with --apply to fire step5 on each row.");
    return;
  }

  if (advances.length === 0) {
    log();
    log("Nothing to advance.");
    return;
  }

  log();
  log("─".repeat(78));
  log(`Advancing ${advances.length} case(s) via action=advance-step5…`);
  log("─".repeat(78));
  let ok = 0; let fail = 0;
  for (const a of advances) {
    const r = await advance(a.tc.id);
    if (r.ok) { log(`  ✓ advanced case=${a.tc.id.slice(0, 8)}`); ok++; }
    else { log(`  ✗ FAILED  case=${a.tc.id.slice(0, 8)}: ${r.error}`); fail++; }
  }
  log();
  log(`Advanced: ${ok}  Failed: ${fail}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
