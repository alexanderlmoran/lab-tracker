// One-off review: (1) duplicate-note detection across iv_sessions, (2) dump the
// component sections of given PB notes (incl. the base/"Centner wellness" master
// note → the authoritative catalog) so we can see exactly what posted.
//
// Run: cd worker && npx tsx scripts/iv-review-notes.ts <noteId> [noteId...]

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
const lc = (s?: string) => (s ?? "").toLowerCase();

async function rest(path: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  return JSON.parse(await res.body.text());
}

function dumpSections(scaffold: any[], label: string) {
  console.log(`\n── ${label} ──`);
  let any = false;
  for (const item of scaffold) {
    const q = item.question;
    if (!q || q.object !== "matrix") continue;
    const t = lc(q.title);
    if (/vital|attempt|location|reaction|removal|assess|shot given/.test(t)) continue;
    const cols = (q.columns ?? []).map((c: any) => c.label);
    const stdIdx = cols.findIndex((c: string) => /dose/i.test(c ?? ""));
    const rows = (q.rows ?? []).filter((r: any) => (r.label ?? "").trim() && !/^\[enter/i.test(r.label));
    if (!rows.length) continue;
    any = true;
    console.log(`  § ${q.title}`);
    for (const row of rows) {
      const dose = stdIdx >= 0 ? (row.cells?.[stdIdx]?.label ?? "") : "";
      console.log(`     • ${row.label}${dose ? `   [std: ${dose}]` : ""}`);
    }
  }
  if (!any) console.log("  (no component sections)");
}

async function main() {
  // ── 1. Duplicate detection: >1 posted note for same patient + date ──────
  const posted = (await rest(
    "iv_sessions?pb_note_id=not.is.null&select=patient_full_name,session_date,service_name,kind,pb_note_id&order=session_date.desc&limit=300",
  )) as any[];
  const byKey = new Map<string, any[]>();
  for (const s of posted) {
    const k = `${lc(s.patient_full_name)}|${s.session_date}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }
  console.log("══ DUPLICATE CHECK — same patient + date with >1 posted note ══");
  let dups = 0;
  for (const [k, rows] of byKey) {
    if (rows.length < 2) continue;
    dups++;
    console.log(`  ⚠ ${rows[0].patient_full_name} · ${rows[0].session_date} — ${rows.length} notes:`);
    for (const r of rows) console.log(`      ${r.kind.padEnd(8)} "${r.service_name}"  note=${r.pb_note_id}`);
  }
  if (!dups) console.log("  ✅ none");

  // ── 2. Dump given notes' component sections ─────────────────────────────
  const ids = process.argv.slice(2);
  if (ids.length) {
    const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
    for (const id of ids) {
      try {
        const note: any = await getSessionNote(pb, id);
        dumpSections(scaffoldFromNote(note), `${id}  "${note?.name ?? note?.title ?? "?"}"`);
      } catch (e) {
        console.log(`\n❌ ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
