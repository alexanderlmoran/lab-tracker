// SAFE, self-restoring discovery probe for the PB profile-UPDATE endpoint, run
// ONLY against the test patient (Leila). It reads her record, flips homePhone to
// a throwaway value, tries PUT then POST to records/<id>, confirms the change
// stuck, then RESTORES the original value. Net-zero change. No PHI printed.
//
// This is the one PB write we can't auto-run (classifier-gated). Run it yourself:
//   cd worker && npx tsx scripts/iv-pb-enrich-probe.ts
// Then paste the output back so the updatePbProfile() builder uses the right verb.

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbRequest, pbApiHeaders, PB_BASE } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const LEILA = process.env.PB_TEST_PATIENT_ID || "641868664a3099220158325b";
const TEST_PHONE = "5550009999";

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const h = (write = false) => ({ ...pbApiHeaders(pb), accept: "application/json", ...(write ? { "content-type": "application/json" } : {}) });
  const url = `${PB_BASE}/api/consultant/records/${LEILA}`;
  const getRec = async () => JSON.parse(await (await pbRequest(url, { method: "GET", headers: h() })).body.text());

  const rec = await getRec();
  const orig = rec.profile.homePhone ?? null;
  console.log(`record loaded; homePhone currently ${orig ? "set" : "empty"}`);
  rec.profile.homePhone = TEST_PHONE;

  let worked = "";
  for (const method of ["PUT", "POST"]) {
    const r = await pbRequest(url, { method, headers: h(true), body: JSON.stringify(rec) });
    const t = await r.body.text();
    console.log(`${method} records/<id> → ${r.statusCode}  ${t.slice(0, 90).replace(/\s+/g, " ")}`);
    if (r.statusCode < 300) {
      const back = await getRec();
      const ok = back.profile.homePhone === TEST_PHONE;
      console.log(`  readback changed? ${ok ? "YES ✅" : "no"}`);
      if (ok) {
        worked = method;
        back.profile.homePhone = orig; // restore
        const rr = await pbRequest(url, { method, headers: h(true), body: JSON.stringify(back) });
        const rb = await getRec();
        console.log(`  restore → ${rr.statusCode}; homePhone restored? ${(rb.profile.homePhone ?? null) === orig ? "YES ✅" : "⚠ NO — set it back manually"}`);
      }
      break;
    }
  }
  console.log(worked ? `\n✅ profile update verb = ${worked} /api/consultant/records/<id> (full record body)` : `\n❌ neither PUT nor POST worked — capture via Chrome instead`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
