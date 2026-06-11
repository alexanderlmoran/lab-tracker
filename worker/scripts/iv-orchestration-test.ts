// FULL worker-loop orchestration test against the test patient (Leila).
// Exercises the real path: queued job → /api/worker/iv-post/next (atomic claim +
// dob enrichment + ref resolution) → matcher ≥95 → createSessionNote →
// /api/worker/iv-post/result → DB updated. Uses the live local app
// (TRACKER_BASE_URL) + shared Supabase.
//
// Subcommands (run iv-post-worker.ts between setup and verify):
//   setup    — safety preflight (queue must be empty), then seed a synthetic
//              Leila session + template-ref + queued job. Uses Leila's REAL PB
//              identity so the matcher scores ≥95.
//   verify   — assert the job succeeded + note id set + session marked posted.
//   cleanup  — delete every row this test created (idempotent, by marker).
//
// Run:
//   npx tsx scripts/iv-orchestration-test.ts setup
//   npx tsx scripts/iv-post-worker.ts
//   npx tsx scripts/iv-orchestration-test.ts verify
//   npx tsx scripts/iv-orchestration-test.ts cleanup

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, searchPbPatientCandidates } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SECRET_KEY!;
if (!SUPA || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY required");

const ZAPPT = "TEST-IV-ORCH-LEILA";       // marker on the synthetic iv_session
const THINT = "TEST-IV-ORCH";             // marker template_hint
const SEED_NOTE = "TEST-IV-ORCH (delete me)"; // marker on any patients_seed row we add
const REF_NOTE = process.env.IV_VERIFY_REF_NOTE || "6a272b54271793958adbbdc2";
const TODAY = new Date().toISOString().slice(0, 10);

const SAMPLE_CHART = {
  assessment: { initialCheckIn: true, risksDiscussed: true, consentSigned: true, intakeSigned: true, historyDiscussed: true },
  preVitals: { bp: "118/76", spo2: "98", temp: "98.4", hr: "68", resp: "14" },
  postVitals: { bp: "121/79", spo2: "99", temp: "98.7", hr: "71", resp: "16" },
  ivStart: { cath: "22" }, attempts: "1", location: "right_antecubital", infusionFlowingWell: true,
  components: [{ name: "Vitamin C", standardDose: "500mg/ml", lot: "ORCH-LOT-1", exp: "2027-12" }],
  infusionReaction: { occurred: false }, ivRemoval: true,
  notes: "Automated orchestration test — safe to delete.",
};

async function rest(method: string, path: string, body?: unknown, prefer?: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`REST ${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function setup() {
  // ── SAFETY: the worker drains the whole queue. Refuse to run if any real
  // queued/claimed job exists (we'd auto-post real clinical notes).
  const live = await rest("GET", `iv_post_jobs?status=in.(queued,claimed)&select=id,session_id,status`);
  if (Array.isArray(live) && live.length) {
    throw new Error(`ABORT: ${live.length} queued/claimed job(s) already in iv_post_jobs — not safe to run the worker. Clear them first.`);
  }
  console.log("✓ preflight: queue empty (safe to run the drain worker)");

  // ── Leila's real PB identity (so the matcher scores ≥95). Not printed.
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const cands = await searchPbPatientCandidates(pb, process.env.PB_TEST_PATIENT_NAME!);
  const leila = cands.find((c) => c.id === process.env.PB_TEST_PATIENT_ID) ?? cands[0];
  if (!leila?.emailAddress || !leila?.dayOfBirth) throw new Error("test patient missing email/dob in PB");

  // ── patients_seed: only add a (marked) row if Leila isn't already seeded.
  const existing = await rest("GET", `patients_seed?email=eq.${encodeURIComponent(leila.emailAddress)}&select=id`);
  if (!Array.isArray(existing) || existing.length === 0) {
    await rest("POST", "patients_seed",
      { patient_name: `${leila.firstName} ${leila.lastName}`, email: leila.emailAddress, dob: leila.dayOfBirth, source: "manual", notes: SEED_NOTE },
      "return=minimal");
    console.log("✓ patients_seed: added marked test row (Leila wasn't seeded)");
  } else {
    console.log("✓ patients_seed: Leila already present (left untouched)");
  }

  // ── template ref + session + queued job.
  await rest("POST", "iv_template_refs",
    { template_hint: THINT, reference_note_id: REF_NOTE, note: "TEST-IV-ORCH" },
    "resolution=merge-duplicates,return=minimal");

  const session = await rest("POST", "iv_sessions",
    {
      zenoti_appointment_id: ZAPPT, patient_first_name: leila.firstName, patient_last_name: leila.lastName,
      patient_full_name: `${leila.firstName} ${leila.lastName}`, patient_email: leila.emailAddress,
      service_name: "IV - Immune Boost (TEST-IV-ORCH)", kind: "standard", session_date: TODAY,
      template_hint: THINT, chart: SAMPLE_CHART, charting_status: "ready",
    },
    "resolution=merge-duplicates,return=representation");
  const sid = (Array.isArray(session) ? session[0] : session).id as string;

  await rest("POST", "iv_post_jobs", { session_id: sid, status: "queued" }, "return=minimal");
  console.log(`✓ seeded session ${sid} + queued job`);
  console.log(`\nNow run:  npx tsx scripts/iv-post-worker.ts`);
}

async function verify() {
  const ses = await rest("GET", `iv_sessions?zenoti_appointment_id=eq.${ZAPPT}&select=id,charting_status,pb_note_id,pb_client_record_id,last_error`);
  const s = Array.isArray(ses) ? ses[0] : null;
  if (!s) throw new Error("test session not found — run setup first");
  const jobs = await rest("GET", `iv_post_jobs?session_id=eq.${s.id}&select=status,match_score,match_reason,pb_note_id,last_error&order=created_at.desc`);
  const j = Array.isArray(jobs) ? jobs[0] : null;

  console.log(`\n── ORCHESTRATION RESULT ──`);
  console.log(`  job.status        : ${j?.status}`);
  console.log(`  job.match_score   : ${j?.match_score}`);
  console.log(`  job.match_reason  : ${(j?.match_reason ?? "").replace(/[^\x20-\x7e]/g, "")}`);
  console.log(`  job.pb_note_id    : ${j?.pb_note_id ?? "—"}`);
  console.log(`  job.last_error    : ${j?.last_error ?? "—"}`);
  console.log(`  session.status    : ${s.charting_status}`);
  console.log(`  session.pb_note_id: ${s.pb_note_id ?? "—"}`);

  const pass = j?.status === "succeeded" && !!j?.pb_note_id && s.charting_status === "posted" && (j?.match_score ?? 0) >= 95;
  console.log(pass ? `\n✅ PASS — queue→claim→match≥95→post→result loop verified end-to-end.` : `\n❌ FAIL — see fields above.`);
  if (s.pb_note_id) console.log(`\n⚠ Delete PB test note ${s.pb_note_id} from Leila's chart.`);
}

async function cleanup() {
  const ses = await rest("GET", `iv_sessions?zenoti_appointment_id=eq.${ZAPPT}&select=id`);
  const s = Array.isArray(ses) ? ses[0] : null;
  if (s) {
    await rest("DELETE", `iv_post_jobs?session_id=eq.${s.id}`, undefined, "return=minimal");
    await rest("DELETE", `iv_sessions?zenoti_appointment_id=eq.${ZAPPT}`, undefined, "return=minimal");
  }
  await rest("DELETE", `iv_template_refs?template_hint=eq.${THINT}`, undefined, "return=minimal");
  await rest("DELETE", `patients_seed?notes=eq.${encodeURIComponent(SEED_NOTE)}`, undefined, "return=minimal");
  console.log("✓ cleanup: removed test job, session, template-ref, and any marked patients_seed row.");
  console.log("  (PB note on Leila must still be deleted manually in PB.)");
}

const cmd = process.argv[2];
const fn = cmd === "setup" ? setup : cmd === "verify" ? verify : cmd === "cleanup" ? cleanup : null;
if (!fn) { console.error("usage: iv-orchestration-test.ts <setup|verify|cleanup>"); process.exit(1); }
fn().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
