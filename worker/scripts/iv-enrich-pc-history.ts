// Bootstrap the LOCAL PC infusion-series ledger (iv_infusion_series) from PB —
// the one-time backfill. For every PC patient (by zenoti_guest_id) that has no
// ledger row yet, read their last "Infusion #N" note in PB ONCE and seed
// last_number with it. After this runs, the infusion number is owned locally and
// assigned at post time (src/app/api/worker/iv-post/next) — PB is never read for
// history again.
//
// Idempotent: only seeds guests that aren't seeded yet (never clobbers a count
// we've been incrementing). Safe to re-run; new PC patients get picked up.
// Run from a clean IP (PB egress): cd worker && npx tsx scripts/iv-enrich-pc-history.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { readPbInfusionSeed } from "../src/iv/pc-series.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
const DRY = !process.env.IV_SEED_COMMIT; // dry by default; IV_SEED_COMMIT=1 writes

async function rest(method: string, path: string, body?: unknown, prefer = "return=minimal") {
  const res = await request(`${SUPA}/rest/v1/${path}`, { method, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const txt = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${method} ${path} ${res.statusCode}: ${txt.slice(0, 150)}`);
  return txt ? JSON.parse(txt) : null;
}

async function main() {
  const pcs = (await rest("GET", "iv_sessions?kind=eq.pc&zenoti_guest_id=not.is.null&select=zenoti_guest_id,patient_full_name,patient_first_name,patient_last_name,patient_email,patient_phone&limit=2000")) as any[];
  const seededRows = (await rest("GET", "iv_infusion_series?series=eq.pc&seeded=eq.true&select=zenoti_guest_id")) as any[];
  const seededSet = new Set(seededRows.map((r) => r.zenoti_guest_id));
  const byGuest = new Map<string, any>();
  for (const s of pcs) {
    const g = (s.zenoti_guest_id ?? "").trim();
    if (!g || seededSet.has(g) || byGuest.has(g)) continue;
    byGuest.set(g, s);
  }
  const patients = [...byGuest.values()];
  if (!patients.length) { console.log("ledger already covers every PC patient — nothing to seed."); return; }
  console.log(`\n══ ${DRY ? "DRY RUN — " : ""}seeding ${patients.length} PC patient(s) ══`);
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  for (const s of patients) {
    const identity = { fullName: s.patient_full_name, firstName: s.patient_first_name, lastName: s.patient_last_name, email: s.patient_email, phone: s.patient_phone };
    const seed = await readPbInfusionSeed(pb, identity);
    if (seed.lastNumber == null) {
      // Ambiguous (candidates, no confident match) — DON'T seed; staff sets the #.
      console.log(`  ⤬ ${identity.fullName}: ${seed.reason} → SKIPPED`);
      continue;
    }
    console.log(`  ${DRY ? "·" : "✅"} ${identity.fullName}: ${seed.reason} → seed last_number=${seed.lastNumber}`);
    if (!DRY) {
      await rest("POST", "iv_infusion_series", { zenoti_guest_id: s.zenoti_guest_id, series: "pc", last_number: seed.lastNumber, last_vial_count: seed.lastVials, patient_full_name: identity.fullName, seeded: true }, "resolution=merge-duplicates");
    }
  }
  console.log(DRY ? "\nDRY RUN — re-run with IV_SEED_COMMIT=1 to write." : "\nseed complete.");
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
