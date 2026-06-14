// Zenoti -> tracker patient enrichment ("1 feeds the rest", Step 2).
//
// Pulls a day's IV + lab appointments, collects each unique guest, looks up the
// full guest profile (DOB / sex / address — the fields the appointment payload
// lacks), and upserts the five identity points into patients_seed via the app's
// /api/worker/patient-enrich endpoint.
//
// Standalone on purpose: it does NOT touch the live zenoti-iv-sync, so it can't
// risk the working pipeline. Schedule it on Fly alongside the other sync loops
// once verified.
//
// Run (DRY — pull + print only, writes nothing, needs only the Zenoti session):
//   cd worker
//   npx tsx scripts/zenoti-enrich.ts
//   ZENOTI_DATE=2026-06-13 ZENOTI_STORAGE=captures/zenoti/<dir>/storage.json \
//     npx tsx scripts/zenoti-enrich.ts
//
// Run (APPLY — also upsert into patients_seed; needs TRACKER_BASE_URL +
// WORKER_SHARED_SECRET in worker/.env.local):
//   ZENOTI_ENRICH_APPLY=1 npx tsx scripts/zenoti-enrich.ts

import {
  fetchZenotiIvAppointments,
  fetchZenotiLabAppointments,
  enrichGuestProfiles,
  zenotiGenderToSex,
  formatGuestAddress,
} from "../src/zenoti/fetch-browser.js";
import type { PatientEnrichRecord } from "../src/tracker-client.js";

const STORAGE_PATH =
  process.env.ZENOTI_STORAGE ?? "captures/zenoti/20260609-160220/storage.json";
const DATE = process.env.ZENOTI_DATE ?? new Date().toISOString().slice(0, 10);
const APPLY = process.env.ZENOTI_ENRICH_APPLY === "1";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  log(`storage:  ${STORAGE_PATH}`);
  log(`date:     ${DATE}`);
  log(`mode:     ${APPLY ? "APPLY (will upsert patients_seed)" : "DRY RUN (no writes)"}`);
  log("");

  // Both appointment kinds — a patient might have a lab OR an IV that day; we
  // want every guest enriched regardless.
  const [iv, lab] = await Promise.all([
    fetchZenotiIvAppointments({ storagePath: STORAGE_PATH, date: DATE }),
    fetchZenotiLabAppointments({ storagePath: STORAGE_PATH, date: DATE }),
  ]);

  // Unique guests for the day, carrying the appointment's name/email as fallback
  // for guests whose profile happens to omit them.
  const guests = new Map<string, { fullName: string; email: string | null }>();
  for (const a of [...iv, ...lab]) {
    if (!a.zenotiGuestId) continue;
    if (!guests.has(a.zenotiGuestId)) {
      guests.set(a.zenotiGuestId, { fullName: a.patientFullName, email: a.patientEmail });
    }
  }
  log(`${iv.length} IV + ${lab.length} lab appt(s) -> ${guests.size} unique guest(s)`);
  if (guests.size === 0) {
    log("nothing to enrich — exiting clean.");
    return;
  }

  const profiles = await enrichGuestProfiles(STORAGE_PATH, [...guests.keys()]);

  const records: PatientEnrichRecord[] = [];
  log("");
  log("Resolved profiles (the 5 data points):");
  for (const [guestId, fallback] of guests) {
    const p = profiles.get(guestId);
    if (!p) {
      log(`  ${fallback.fullName.padEnd(26)}  (profile lookup failed — skipped)`);
      continue;
    }
    const email = p.email ?? fallback.email;
    const name = p.fullName || fallback.fullName;
    const sex = zenotiGenderToSex(p.gender);
    const address = formatGuestAddress(p.address);
    log(
      `  ${name.padEnd(26)}  dob=${(p.dateOfBirth ?? "—").padEnd(10)} sex=${
        sex ?? "—"
      }  ${email ?? "(no email)"}`,
    );
    log(`     phone:   ${p.mobilePhone ?? "—"}`);
    log(`     address: ${address ?? "—"}`);
    if (!email) {
      log("     -> SKIP: no email, can't key patients_seed");
      continue;
    }
    records.push({
      name,
      email,
      phone: p.mobilePhone,
      dob: p.dateOfBirth,
      sex,
      address,
    });
  }

  log("");
  log(`${records.length} record(s) ready to upsert into patients_seed.`);
  if (!APPLY) {
    log("DRY RUN — set ZENOTI_ENRICH_APPLY=1 to write them.");
    return;
  }

  const { postPatientEnrich } = await import("../src/tracker-client.js");
  const res = await postPatientEnrich(records);
  log(`upserted=${res.upserted} skipped=${res.skipped}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
