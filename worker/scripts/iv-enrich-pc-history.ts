// Continue the patient's PC infusion series: for each PENDING PC session with no
// infusion # yet, find the patient's most recent "Phosphatidylcholine Infusion"
// note in PB, parse its "Infusion #N (#X Vials)", and set the session's
// pc_infusion_number = N+1 and pc_vial_count = X so the charting form prefills
// them. Read-only match (name-confident is enough; email conflict still OK for a
// history READ that staff verify). PB egress required.
//
// Run: cd worker && npx tsx scripts/iv-enrich-pc-history.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, searchPbPatientCandidates } from "../src/uploaders/practicebetter.js";
import { listSessionNotes } from "../src/uploaders/pb-sessionnotes.js";
import { parseInfusionTitle } from "../src/iv/build-note-content.js";
import { pickBestMatch } from "../src/iv/match-patient.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
async function rest(method: string, path: string, body?: unknown) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { method, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=minimal" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const txt = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${method} ${path} ${res.statusCode}: ${txt.slice(0, 150)}`);
  return txt ? JSON.parse(txt) : null;
}

async function main() {
  const sessions = (await rest("GET", "iv_sessions?kind=eq.pc&charting_status=eq.pending&pc_infusion_number=is.null&select=id,patient_full_name,patient_first_name,patient_last_name,patient_email,patient_phone&limit=100")) as any[];
  if (!sessions.length) { console.log("no pending PC sessions needing a history reference."); return; }
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  console.log(`\n══ enriching ${sessions.length} pending PC session(s) ══`);
  for (const s of sessions) {
    const identity = { fullName: s.patient_full_name, firstName: s.patient_first_name, lastName: s.patient_last_name, email: s.patient_email, phone: s.patient_phone };
    const cands = await searchPbPatientCandidates(pb, (identity.fullName || identity.email || "").trim());
    const best = pickBestMatch(identity, cands);
    if (!best || best.signals.name !== "full") { console.log(`  ? ${s.patient_full_name}: no confident name match — skip`); continue; }
    const notes = await listSessionNotes(pb, best.candidate.id, 50);
    const pcs = notes
      .map((n: any) => ({ name: n.name as string, date: String(n.sessionDate ?? ""), p: parseInfusionTitle(n.name) }))
      .filter((x) => x.p && /phosphatidylcholine/i.test(x.name))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!pcs.length) { console.log(`  - ${s.patient_full_name}: no prior PC infusion note`); continue; }
    const last = pcs[0];
    const next = last.p!.number + 1;
    await rest("PATCH", `iv_sessions?id=eq.${s.id}`, { pc_infusion_number: next, pc_vial_count: last.p!.vials });
    console.log(`  ✅ ${s.patient_full_name}: last "#${last.p!.number} (${last.p!.vials})" (${last.date.slice(0, 10)}) → set #${next}, vials ${last.p!.vials}`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
