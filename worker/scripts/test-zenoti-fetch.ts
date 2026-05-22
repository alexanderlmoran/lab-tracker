// Dry-run: pull today's lab appointments out of Zenoti using captured
// session cookies, and report what the production sync would create.
// Writes NOTHING to the tracker DB.
//
// Run:
//   cd worker
//   npx tsx scripts/test-zenoti-fetch.ts
//   ZENOTI_DATE=2026-05-22 npx tsx scripts/test-zenoti-fetch.ts
//
// If you see auth errors, re-run the capture skill to refresh storage.json
// and update STORAGE_PATH below.

import { fetchZenotiLabAppointments } from "../src/zenoti/fetch-browser.js";

const STORAGE_PATH = "captures/zenoti/20260521-202910/storage.json";
const DATE = process.env.ZENOTI_DATE ?? new Date().toISOString().slice(0, 10);

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  log(`storage: ${STORAGE_PATH}`);
  log(`date:    ${DATE}`);

  const appts = await fetchZenotiLabAppointments({
    storagePath: STORAGE_PATH,
    date: DATE,
  });

  log(`found ${appts.length} lab appointment(s) on ${DATE}`);
  if (appts.length === 0) {
    log("no lab appointments — exiting clean.");
    return;
  }

  log("");
  log("Parsed appointments:");
  for (const a of appts) {
    log(
      `  ${a.patientFullName.padEnd(28)}  ${a.labName.padEnd(10)}  ${
        a.startAt ?? "(no time)"
      }  zenoti=${a.zenotiAppointmentId}`,
    );
    log(`     service:    ${a.serviceName}`);
    if (a.note) log(`     note:       ${a.note.replace(/\n/g, " | ")}`);
    if (a.patientEmail) log(`     email:      ${a.patientEmail}`);
    if (a.patientPhone) log(`     phone:      ${a.patientPhone}`);
    if (a.therapistName) log(`     therapist:  ${a.therapistName}`);
  }

  log("");
  log("DRY RUN — what production sync would UPSERT into lab_cases:");
  for (const a of appts) {
    const name = a.patientFullName || `${a.patientFirstName} ${a.patientLastName}`;
    log(`  ON zenoti_appointment_id = ${a.zenotiAppointmentId}`);
    log(`    patient_name:           ${name}`);
    log(`    patient_email:          ${a.patientEmail ?? "(none — Zenoti row blank)"}`);
    log(`    patient_phone:          ${a.patientPhone ?? "(none)"}`);
    log(`    lab_name:               ${a.labName}`);
    log(`    collection_date:        ${a.collectionDate ?? "(unparseable)"}`);
    log(`    zenoti_guest_id:        ${a.zenotiGuestId}`);
    log(`    notes:                  ${a.note ?? "(none)"}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
