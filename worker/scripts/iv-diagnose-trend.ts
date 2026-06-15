// One-off diagnosis: WHY are IV notes not auto-posting / posting without doses?
// Reads the DB only (service key) — no PB. Every post attempt records its hold
// reason + match score in iv_post_jobs, and each session's chart shows whether
// components carry doses. Summarizes the trend + drills into one patient.
//
// Run: cd worker && npx tsx scripts/iv-diagnose-trend.ts [patientNameFragment]

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
const NAME = (process.argv[2] ?? "leila").toLowerCase();

async function rest(path: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const txt = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${path} ${res.statusCode}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

type Comp = { name?: string; standardDose?: string; addOnDose?: string };
const named = (chart: any): Comp[] => ((chart?.components ?? []) as Comp[]).filter((c) => (c.name ?? "").trim());
const dosed = (c: Comp) => !!((c.standardDose ?? "").trim() || (c.addOnDose ?? "").trim());
function doseState(chart: any): string {
  const cs = named(chart);
  if (cs.length === 0) return "NO components";
  const missing = cs.filter((c) => !dosed(c));
  return missing.length ? `${cs.length - missing.length}/${cs.length} dosed — MISSING: ${missing.map((c) => c.name).join(", ")}` : `${cs.length}/${cs.length} dosed`;
}

async function main() {
  // ── 1. Post-job outcomes (the auto-post truth) ──────────────────────────
  const jobs = (await rest(
    "iv_post_jobs?select=status,match_score,match_reason,last_error,pb_note_id,created_at,iv_sessions(service_name,patient_full_name,session_date,kind,charting_status,template_hint)&order=created_at.desc&limit=80",
  )) as any[];
  const byStatus = new Map<string, number>();
  for (const j of jobs) byStatus.set(j.status, (byStatus.get(j.status) ?? 0) + 1);
  console.log(`\n══ post-job outcomes (last ${jobs.length}) ══`);
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(10)} ${n}`);

  // Reasons for everything not 'succeeded'
  const stuck = jobs.filter((j) => j.status !== "succeeded");
  const reasonCount = new Map<string, number>();
  for (const j of stuck) {
    const r = (j.match_reason || j.last_error || "(no reason recorded)").replace(/\s+/g, " ").trim();
    reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);
  }
  console.log(`\n══ WHY not auto-posted (${stuck.length} non-success jobs) ══`);
  for (const [r, n] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ×${n}  ${r.slice(0, 120)}`);

  console.log(`\n══ recent non-success jobs (detail) ══`);
  for (const j of stuck.slice(0, 20)) {
    const s = j.iv_sessions ?? {};
    console.log(`  [${j.status}] ${(s.patient_full_name ?? "?").padEnd(22)} ${(s.kind ?? "?").padEnd(8)} score=${j.match_score ?? "—"}  ${s.session_date ?? ""}  "${s.service_name ?? ""}"`);
    console.log(`        ↳ ${(j.match_reason || j.last_error || "—").slice(0, 130)}`);
  }

  // ── 2. Dose presence across recent charted sessions ─────────────────────
  const sess = (await rest(
    "iv_sessions?select=id,patient_full_name,service_name,kind,charting_status,session_date,start_at,template_hint,pb_note_id,chart&order=session_date.desc&limit=120",
  )) as any[];
  const charted = sess.filter((s) => s.charting_status === "ready" || s.pb_note_id);
  const missingDose = charted.filter((s) => {
    const cs = named(s.chart);
    return cs.length === 0 || cs.some((c) => !dosed(c));
  });
  console.log(`\n══ dose presence (of ${charted.length} charted/posted sessions) ══`);
  console.log(`  ${charted.length - missingDose.length} fully dosed · ${missingDose.length} missing a dose`);
  for (const s of missingDose.slice(0, 20)) {
    console.log(`  ⚠ ${(s.patient_full_name ?? "?").padEnd(22)} ${(s.kind ?? "").padEnd(8)} ${s.session_date}  tmpl="${s.template_hint ?? ""}"  → ${doseState(s.chart)}`);
  }

  // ── 3. Clock check + patient drill-down ─────────────────────────────────
  const who = (await rest(
    `iv_sessions?patient_full_name=ilike.*${encodeURIComponent(NAME)}*&select=id,patient_full_name,service_name,kind,charting_status,session_date,start_at,template_hint,pb_note_id,chart&order=session_date.desc&limit=20`,
  )) as any[];
  console.log(`\n══ drill-down: "${NAME}" (${who.length} session(s)) ══`);
  for (const s of who) {
    console.log(`  ${s.patient_full_name} · ${s.kind} · ${s.service_name}`);
    console.log(`     session_date=${s.session_date}  start_at=${s.start_at}  (raw, no tz)  status=${s.charting_status}  posted=${s.pb_note_id ? "YES " + s.pb_note_id : "no"}`);
    console.log(`     template_hint="${s.template_hint}"  components: ${doseState(s.chart)}`);
    const cs = named(s.chart);
    if (cs.length) cs.forEach((c) => console.log(`       - ${c.name}  std="${c.standardDose ?? ""}" addon="${c.addOnDose ?? ""}"`));
    // its post job(s)
    const myJobs = (await rest(`iv_post_jobs?session_id=eq.${s.id}&select=status,match_score,match_reason,last_error,pb_note_id,created_at`)) as any[];
    for (const j of myJobs) console.log(`     job: [${j.status}] score=${j.match_score ?? "—"} ${j.pb_note_id ? "note=" + j.pb_note_id : ""}  ${(j.match_reason || j.last_error || "").slice(0, 120)}`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
