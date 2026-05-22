// One-off test: upload an Access lab PDF to Leila Centner's PB chart via the
// pure-HTTP uploader. Does NOT touch the tracker DB or the worker pipeline.
// If this works → wire up the production approval flow with confidence.
//
// Run:
//   cd worker
//   PB_USERNAME=info@centnerhb.com PB_PASSWORD='...' \
//   PB_CONSULTANT_ID=67200c656578f95a89af7534 \
//     npx tsx scripts/test-pb-upload-leila.ts
//
// PB_CONSULTANT_ID comes from the capture HAR (Alexander Moran's PB user id).
// In production we'll look this up dynamically via /api/company/administration/members
// and cache it; the env var here is the shortest path to a working test.

import { join } from "node:path";
import { homedir } from "node:os";
import { uploadPdfToPb } from "../src/uploaders/practicebetter.js";

const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
const PB_CONSULTANT_ID = process.env.PB_CONSULTANT_ID;

if (!PB_USERNAME || !PB_PASSWORD || !PB_CONSULTANT_ID) {
  console.error(
    "Set PB_USERNAME, PB_PASSWORD, PB_CONSULTANT_ID env vars before running.",
  );
  process.exit(1);
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  // Pick one of the Access PDFs we already have on disk.
  const pdfFilename = "access_007138032.pdf"; // Leila's 05/19 collection
  const pdfPath = join(homedir(), "Desktop", "leila", pdfFilename);

  log(`uploading ${pdfPath}`);
  log("  → patient: Leila Centner (DOB 1976-12-28)");

  const result = await uploadPdfToPb({
    username: PB_USERNAME!,
    password: PB_PASSWORD!,
    consultantId: PB_CONSULTANT_ID!,
    patientName: "Leila Centner",
    patientDob: "1976-12-28",
    labName: "Access — test upload (delete me)",
    dateOrdered: "2026-05-19T00:00:00.000Z",
    pdfPath,
    pdfFilename,
    isClientFacing: false,
    notify: false, // suppress patient email for this test
  });

  log(`✓ created labrequest ${result.labRequestId}`);
  log(`✓ patientId ${result.patientId}`);
  log("");
  log("Verify in PB UI:");
  log("  1. Log in as info@centnerhb.com");
  log("  2. Search → Leila Centner → Labs tab");
  log("  3. Look for 'Access — test upload (delete me)' with PDF attached");
  log("  4. Delete the test lab when satisfied");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
