// Read-only health check for the PC infusion-series ledger (iv_infusion_series).
// Run after applying 20260616_iv_infusion_series.sql (and/or the bootstrap seed):
//   cd worker && npx tsx scripts/iv-verify-ledger.ts
//
// Reports: table presence, seed coverage (PC patients seeded vs not), the number
// that WOULD be assigned next per seeded patient, and — the footprint of the bug
// this fixes — how many PC notes ALREADY posted to PB with NO infusion number.
// No writes, no PB calls.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;

async function rest(path: string): Promise<{ status: number; rows: any[] }> {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const txt = await res.body.text();
  return { status: res.statusCode, rows: txt && txt.startsWith("[") ? JSON.parse(txt) : [] };
}

async function main() {
  const ledger = await rest("iv_infusion_series?series=eq.pc&select=zenoti_guest_id,last_number,last_vial_count,patient_full_name,seeded&order=last_number.desc");
  if (ledger.status >= 400) {
    console.log(`❌ iv_infusion_series not reachable (status ${ledger.status}) — apply supabase/migrations/20260616_iv_infusion_series.sql in the Supabase SQL editor first.`);
    return;
  }
  const seeded = ledger.rows.filter((r) => r.seeded);
  console.log(`\n══ PC infusion-series ledger ══`);
  console.log(`  seeded rows: ${seeded.length}`);
  for (const r of seeded.slice(0, 25)) {
    console.log(`   • ${r.patient_full_name ?? r.zenoti_guest_id}: at #${r.last_number}${r.last_vial_count ? ` (${r.last_vial_count})` : ""} → next posts #${r.last_number + 1}`);
  }
  if (seeded.length > 25) console.log(`   … and ${seeded.length - 25} more`);

  // Coverage: PC patients (by guest) vs seeded guests.
  const pcs = await rest("iv_sessions?kind=eq.pc&zenoti_guest_id=not.is.null&select=zenoti_guest_id");
  const pcGuests = new Set(pcs.rows.map((r) => r.zenoti_guest_id));
  const seededGuests = new Set(seeded.map((r) => r.zenoti_guest_id));
  const unseeded = [...pcGuests].filter((g) => !seededGuests.has(g));
  console.log(`\n  PC patients: ${pcGuests.size} · seeded: ${pcGuests.size - unseeded.length} · awaiting bootstrap: ${unseeded.length}`);
  if (unseeded.length) console.log(`   (the worker seed pass / iv-enrich-pc-history.ts will cover these — they HOLD until then, never post unnumbered)`);

  // Bug footprint: PC notes already posted to PB with no number (the mismatch).
  const bad = await rest("iv_sessions?kind=eq.pc&pb_note_id=not.is.null&pc_infusion_number=is.null&select=id,patient_full_name,session_date");
  console.log(`\n  ⚠ already-posted PC notes with NO infusion # (pre-fix mismatches): ${bad.rows.length}`);
  for (const r of bad.rows.slice(0, 20)) console.log(`   • ${r.patient_full_name} (${String(r.session_date).slice(0, 10)}) session=${r.id}`);
  if (bad.rows.length) console.log(`   → these were posted before the ledger; re-titling them is a manual PB fixup (or re-post once renumbered).`);
  console.log("");
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
