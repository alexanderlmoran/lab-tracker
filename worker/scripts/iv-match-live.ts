// Read-only: verify the patient matcher against REAL PB candidate data (the
// unit tests use synthetic rows). Builds a "perfect-data" session identity from
// Leila's own PB record, then scores it against the live candidate list.
// Output is REDACTED — only score/signals/decision, never name/dob/email.
//
// Run: cd worker && npx tsx scripts/iv-match-live.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, searchPbPatientCandidates } from "../src/uploaders/practicebetter.js";
import { pickBestMatch, type PatientIdentity } from "../src/iv/match-patient.js";

loadEnvLocal();
const NAME = process.env.PB_TEST_PATIENT_NAME;
if (!NAME) throw new Error("PB_TEST_PATIENT_NAME required");

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const candidates = await searchPbPatientCandidates(pb, NAME!);
  console.log(`✓ ${candidates.length} candidate(s) for the test-patient name query`);

  const leila = candidates.find((c) => c.id === process.env.PB_TEST_PATIENT_ID) ?? candidates[0];
  if (!leila) throw new Error("no candidates returned");

  // Simulate a session whose patients_seed enrichment gave us Leila's real
  // name + dob + email (the ≥95 auto-post case).
  const identity: PatientIdentity = {
    fullName: `${leila.firstName ?? ""} ${leila.lastName ?? ""}`.trim(),
    lastName: leila.lastName,
    email: leila.emailAddress,
    dob: leila.dayOfBirth,
  };
  const best = pickBestMatch(identity, candidates);
  if (!best) throw new Error("pickBestMatch returned null");

  // REDACTED output only.
  console.log(`\n── matcher on real PB data (redacted) ──`);
  console.log(`  best matched id == test patient : ${best.candidate.id === leila.id ? "✅ yes" : "❌ no"}`);
  console.log(`  score          : ${best.score}`);
  console.log(`  signals        : name=${best.signals.name} dob=${best.signals.dob} email=${best.signals.email}`);
  console.log(`  autoPostable   : ${best.autoPostable ? "✅ true (≥95 + clear lead)" : "❌ false"}`);
  console.log(`  reason         : ${best.reason.replace(/[^\x20-\x7e]/g, "")}`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
