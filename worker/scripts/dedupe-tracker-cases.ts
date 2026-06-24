// Archive duplicate tracker rows.
//
// The bulk import inserted some Leila cases twice — same patient, same lab,
// same tracking #, same collection date. Both rows would advance together
// once we start auto-firing step5, leaving the kanban with phantom
// "duplicate complete" cards. Cheaper to archive one per pair now.
//
// True-duplicate definition (intentionally strict):
//   patient_name + lab_name + tracking_number + collection_date
//   + lab_external_ref (accession) all match.
//
// The accession is part of the key because distinct panels are frequently
// shipped in ONE box under ONE tracking# (e.g. Genova / Access send several
// accessions per shipment). Those are SEPARATE results that happen to share a
// tracking#, NOT duplicates — keying on tracking# alone would archive real,
// distinct labs together. Rule: NEVER dedupe two rows whose accessions differ.
// (Rows that both lack an accession can still pair — that's the original
// bulk-import true-duplicate case, where neither row carried an accession.)
//
// This also deliberately excludes cases where lab_name or collection_date
// differs even when tracking# is shared. Example: the Access 5/21 vs
// Access Custom 5/22 pair shares tracking# 487953992901 but represents
// the bulk-import row and the live Zenoti-sync row for the same shipment
// — they're not interchangeable. Those need a separate "Zenoti reconcile"
// pass, not a blunt dedupe.
//
// Canonical row per group: earliest created_at wins (lexicographic id as
// tiebreaker for ties at the same timestamp).
//
// Default is preview. Add --apply to actually archive.
//   cd worker
//   npx tsx scripts/dedupe-tracker-cases.ts                    # Leila, preview
//   npx tsx scripts/dedupe-tracker-cases.ts --apply            # Leila, apply
//   npx tsx scripts/dedupe-tracker-cases.ts --patient=all      # everyone, preview

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const argv = process.argv.slice(2);
const patientArg = argv.find((a) => a.startsWith("--patient="))?.split("=")[1] ?? "leila";
const apply = argv.includes("--apply");

const log = (m = "") => console.log(m);

type TrackerCase = {
  id: string;
  patient_name: string;
  lab_name: string;
  collection_date: string | null;
  tracking_number: string | null;
  lab_external_ref: string | null;
  zenoti_appointment_id: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  step1_sample_sent: boolean;
  step5_complete_uploaded: boolean;
};

async function fetchCases(query: string): Promise<TrackerCase[]> {
  const q = query === "all" ? "" : `q=${encodeURIComponent(query)}&`;
  // limit=all → server paginates the full table (debug GET defaults to 50).
  const url = `${TRACKER_BASE}/api/worker/debug/cases?${q}deleted=null&limit=all`;
  const res = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { ok: boolean; cases: TrackerCase[] };
  return (json.cases ?? []).filter((c) => !c.archived_at);
}

function normTracking(s: string | null): string | null {
  if (!s) return null;
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

/** Normalize an accession (lab_external_ref) for key comparison. Missing/empty
 * → "" so two accession-less rows still pair (the bulk-import true-dup case);
 * any two rows with DIFFERENT non-empty accessions get different keys and are
 * never grouped. */
function normAccession(s: string | null): string {
  if (!s) return "";
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

type Group = { key: string; cases: TrackerCase[] };

function groupTrueDuplicates(cases: TrackerCase[]): Group[] {
  const map = new Map<string, TrackerCase[]>();
  for (const c of cases) {
    const tk = normTracking(c.tracking_number);
    if (!tk) continue; // can't dedupe without tracking#
    if (!c.collection_date) continue; // skip rows we can't safely identify
    // Accession is part of the key: differing accessions → different keys →
    // never grouped (distinct panels in one box are NOT duplicates).
    const key = [
      c.patient_name.trim().toLowerCase(),
      c.lab_name.trim().toLowerCase(),
      tk,
      c.collection_date,
      normAccession(c.lab_external_ref),
    ].join("|");
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return [...map.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, cases]) => ({ key, cases }));
}

function pickCanonical(group: TrackerCase[]): { canonical: TrackerCase; toArchive: TrackerCase[] } {
  // Prefer the row with a Zenoti link (it'd be auto-restored anyway if archived).
  // Otherwise earliest created_at, then smallest id.
  const sorted = [...group].sort((a, b) => {
    const az = a.zenoti_appointment_id ? 1 : 0;
    const bz = b.zenoti_appointment_id ? 1 : 0;
    if (az !== bz) return bz - az;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const [canonical, ...rest] = sorted;
  return { canonical, toArchive: rest };
}

async function archiveCase(id: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?id=${encodeURIComponent(id)}&action=archive`;
  const res = await request(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.statusCode === 200 && !!body.ok, error: body.error };
}

async function main() {
  log("─".repeat(78));
  log(`TRACKER DEDUPE — ${apply ? "APPLY" : "PREVIEW"}  (patient=${patientArg})`);
  log("─".repeat(78));

  const cases = await fetchCases(patientArg);
  log(`Fetched ${cases.length} active cases.`);

  const groups = groupTrueDuplicates(cases);
  log(`Found ${groups.length} duplicate-group(s).`);
  log();

  let toArchiveCount = 0;
  const archivePlan: Array<{ canonical: TrackerCase; archive: TrackerCase }> = [];

  for (const g of groups) {
    const { canonical, toArchive } = pickCanonical(g.cases);
    log("─".repeat(78));
    log(`group: ${g.key}`);
    log(`  KEEP    case=${canonical.id.slice(0, 8)}  created=${canonical.created_at}  zen=${canonical.zenoti_appointment_id ? "yes" : "no"}  step5=${canonical.step5_complete_uploaded}`);
    for (const a of toArchive) {
      log(`  ARCHIVE case=${a.id.slice(0, 8)}  created=${a.created_at}  zen=${a.zenoti_appointment_id ? "yes" : "no"}  step5=${a.step5_complete_uploaded}`);
      archivePlan.push({ canonical, archive: a });
      toArchiveCount++;
    }
  }

  log();
  log("─".repeat(78));
  log("SUMMARY");
  log("─".repeat(78));
  log(`  duplicate groups:    ${groups.length}`);
  log(`  rows to archive:     ${toArchiveCount}`);
  log(`  rows to keep:        ${groups.length}`);

  if (!apply) {
    log();
    log("No writes performed. Re-run with --apply to archive these duplicates.");
    return;
  }

  if (toArchiveCount === 0) {
    log();
    log("Nothing to archive.");
    return;
  }

  log();
  log("─".repeat(78));
  log(`Archiving ${toArchiveCount} duplicate row(s)…`);
  log("─".repeat(78));
  let ok = 0;
  let fail = 0;
  for (const { archive } of archivePlan) {
    const r = await archiveCase(archive.id);
    if (r.ok) { log(`  ✓ archived case=${archive.id.slice(0, 8)}`); ok++; }
    else { log(`  ✗ FAILED  case=${archive.id.slice(0, 8)}: ${r.error}`); fail++; }
  }
  log();
  log(`Archived: ${ok}  Failed: ${fail}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
