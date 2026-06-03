// Read-only diagnostic: dump every lab case for a patient (active, archived,
// AND deleted) so we can see what happened to tracking/accession — were the
// fields cleared on a row, or did a duplicate blank row appear (e.g. a Zenoti
// auto-created card alongside the original)? Prints full per-row state and
// flags same-patient+same-lab duplicates.
//
//   cd worker
//   npx tsx scripts/diagnose-patient.ts stimler
//   npx tsx scripts/diagnose-patient.ts "leila centner"

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const q = process.argv.slice(2).join(" ").trim();
if (!q) throw new Error('Pass a patient name substring, e.g. `npx tsx scripts/diagnose-patient.ts stimler`');

type Case = {
  id: string;
  patient_name: string;
  patient_email: string;
  lab_name: string;
  zenoti_service_name: string | null;
  collection_date: string | null;
  lab_external_ref: string | null;
  tracking_number: string | null;
  zenoti_appointment_id: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const canonLab = (s: string) => {
  const c = (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const p of ["access", "cyrex", "spectracell", "genova", "glycanage", "doctorsdata", "vibrant"]) {
    if (c.includes(p)) return p;
  }
  return c;
};
const normName = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function fetchMatches(): Promise<Case[]> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?q=${encodeURIComponent(q)}&deleted=any&limit=all`;
  const res = await request(url, { method: "GET", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { cases: Case[] };
  return json.cases ?? [];
}

function status(c: Case): string {
  if (c.deleted_at) return "DELETED";
  if (c.archived_at) return "ARCHIVED";
  return "active";
}

async function main() {
  const all = await fetchMatches();
  console.log("=".repeat(96));
  console.log(`PATIENT DIAGNOSTIC — q="${q}"   matched ${all.length} case(s) (incl. archived + deleted)`);
  console.log("=".repeat(96));

  // Group by normalized patient name + canonical lab to surface duplicates.
  const groups = new Map<string, Case[]>();
  for (const c of all) {
    const k = `${normName(c.patient_name)} | ${canonLab(c.lab_name)}`;
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(c);
  }

  for (const [k, rows] of [...groups.entries()].sort()) {
    const dup = rows.filter((r) => !r.deleted_at).length > 1;
    console.log();
    console.log(`▸ ${k}${dup ? "   ⚠ DUPLICATE (>1 non-deleted row)" : ""}`);
    for (const c of rows.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const trk = c.tracking_number ? c.tracking_number : "—";
      const acc = c.lab_external_ref ? c.lab_external_ref : "—";
      const z = c.zenoti_appointment_id ? "Z" : "-";
      console.log(
        `   [${status(c).padEnd(8)}] ${z}  id=${c.id.slice(0, 8)}  ` +
          `trk=${trk.padEnd(20)} acc=${acc.padEnd(14)} ` +
          `coll=${c.collection_date ?? "—"}  email=${c.patient_email}`,
      );
      console.log(
        `              lab="${c.lab_name}"${c.zenoti_service_name ? ` zsvc="${c.zenoti_service_name}"` : ""}  ` +
          `created=${c.created_at.slice(0, 16)}  updated=${c.updated_at.slice(0, 16)}`,
      );
    }
  }

  // Distinct emails — if the patient is split across emails, the board shows
  // them as separate people (one with data, one blank).
  const emails = [...new Set(all.filter((c) => !c.deleted_at).map((c) => c.patient_email.toLowerCase()))];
  console.log();
  console.log("─".repeat(96));
  console.log(`Distinct emails among non-deleted cases: ${emails.length}`);
  for (const e of emails) console.log(`   ${e}`);
  console.log("(If >1, the patient is split into separate groups on the board.)");
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
