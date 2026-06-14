// Dry-run: pull ONE Zenoti guest's full profile (DOB + gender + address +
// name/email/phone) via the V1 REST API, headlessly, using captured session
// cookies. Writes NOTHING. This is the Step-1 probe for the "1 feeds the rest"
// enrichment (Zenoti -> tracker -> PB).
//
// Run:
//   cd worker
//   npx tsx scripts/test-zenoti-guest-profile.ts
//   ZENOTI_GUEST_ID=<uuid> ZENOTI_STORAGE=captures/zenoti/<dir>/storage.json \
//     npx tsx scripts/test-zenoti-guest-profile.ts
//
// If you see a 302 / "session expired" error, the cookies are stale — re-run
// the lab-portal-capture skill for zenoti and point ZENOTI_STORAGE at the new
// storage.json.

import { fetchZenotiGuestProfile } from "../src/zenoti/fetch-browser.js";

const STORAGE_PATH =
  process.env.ZENOTI_STORAGE ?? "captures/zenoti/20260609-160220/storage.json";
// Default guest = the one captured in the 20260521 HAR (Leila Centner) — just a
// connectivity check; override with ZENOTI_GUEST_ID for a real patient.
const GUEST_ID =
  process.env.ZENOTI_GUEST_ID ?? "ac13e1a8-15eb-4e0c-ac22-0bd7b1259c13";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  log(`storage:  ${STORAGE_PATH}`);
  log(`guestId:  ${GUEST_ID}`);
  log("");

  const p = await fetchZenotiGuestProfile({
    storagePath: STORAGE_PATH,
    guestId: GUEST_ID,
  });

  log("Guest profile (the 5 data points + gender):");
  log(`  name:     ${p.fullName}${p.middleName ? ` (mid: ${p.middleName})` : ""}`);
  log(`  email:    ${p.email ?? "(none)"}`);
  log(`  phone:    ${p.mobilePhone ?? "(none)"}`);
  log(`  DOB:      ${p.dateOfBirth ?? "(none on file)"}`);
  log(`  gender:   ${p.gender ?? "(unspecified)"}`);
  const a = p.address;
  const addr = [a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean).join(", ");
  log(`  address:  ${addr || "(none on file)"}`);
  log("");
  log("Raw normalized record:");
  log(JSON.stringify(p, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
