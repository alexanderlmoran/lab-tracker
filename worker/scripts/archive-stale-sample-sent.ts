// Archive stale cases sitting in the "Sample Sent" kanban column.
//
// "Sample Sent" column rule (mirrors getColumnFor in src/lib/columns.ts):
//   not archived AND step1_sample_sent=true AND step2..step7 all false.
// These are cases where the sample was sent but no result ever came back.
//
// This archives the ones whose collection_date is before a cutoff (default
// 2026-04-01) — old samples that will never resolve. Cases with NO
// collection_date are reported but NOT archived (can't date them safely).
//
// Default is preview. Add --apply to archive (reversible: sets archived_at).
//   cd worker
//   npx tsx scripts/archive-stale-sample-sent.ts                       # preview
//   npx tsx scripts/archive-stale-sample-sent.ts --apply               # archive
//   npx tsx scripts/archive-stale-sample-sent.ts --before=2026-04-01   # custom cutoff

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const BEFORE = argv.find((a) => a.startsWith("--before="))?.split("=")[1] ?? "2026-04-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(BEFORE)) throw new Error("--before must be YYYY-MM-DD");

const log = (m = "") => console.log(m);

type Case = {
  id: string;
  patient_name: string;
  lab_name: string;
  collection_date: string | null;
  created_at: string;
  archived_at: string | null;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step3_partial_uploaded: boolean;
  step4_complete_received: boolean;
  step5_complete_uploaded: boolean;
  step6_rof_scheduled: boolean;
  step7_rof_completed: boolean;
};

/** Mirrors the sample_sent lane in src/lib/columns.ts getColumnFor. */
function isSampleSent(c: Case): boolean {
  return (
    !c.archived_at &&
    c.step1_sample_sent &&
    !c.step2_partial_received &&
    !c.step3_partial_uploaded &&
    !c.step4_complete_received &&
    !c.step5_complete_uploaded &&
    !c.step6_rof_scheduled &&
    !c.step7_rof_completed
  );
}

async function fetchAll(): Promise<Case[]> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?deleted=null&limit=all`;
  const res = await request(url, { method: "GET", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { cases: Case[] };
  return json.cases ?? [];
}

async function archive(id: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?id=${encodeURIComponent(id)}&action=archive`;
  const res = await request(url, { method: "PATCH", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.statusCode === 200 && !!body.ok, error: body.error };
}

async function main() {
  log("─".repeat(78));
  log(`ARCHIVE STALE "SAMPLE SENT" — ${apply ? "APPLY" : "PREVIEW"}  (collection_date < ${BEFORE})`);
  log("─".repeat(78));

  const all = await fetchAll();
  const sampleSent = all.filter(isSampleSent);
  log(`Active cases: ${all.length}   |   in Sample Sent column: ${sampleSent.length}`);

  const toArchive = sampleSent.filter((c) => c.collection_date && c.collection_date < BEFORE);
  const noDate = sampleSent.filter((c) => !c.collection_date);

  log();
  log("─".repeat(78));
  log(`TO ARCHIVE  (${toArchive.length})  — Sample Sent, collection_date < ${BEFORE}`);
  log("─".repeat(78));
  for (const c of toArchive) {
    log(`  case=${c.id.slice(0, 8)}  ${c.lab_name.padEnd(16)} collected=${c.collection_date}  ${c.patient_name}`);
  }

  if (noDate.length) {
    log();
    log(`SKIPPED — Sample Sent but NO collection_date (not archived, review manually): ${noDate.length}`);
    for (const c of noDate.slice(0, 20)) {
      log(`  case=${c.id.slice(0, 8)}  ${c.lab_name.padEnd(16)} created=${c.created_at.slice(0, 10)}  ${c.patient_name}`);
    }
    if (noDate.length > 20) log(`  …and ${noDate.length - 20} more`);
  }

  log();
  log("─".repeat(78));
  log("SUMMARY");
  log("─".repeat(78));
  log(`  in Sample Sent column:        ${sampleSent.length}`);
  log(`  → to archive (dated < cutoff): ${toArchive.length}`);
  log(`  → skipped (no date):           ${noDate.length}`);

  if (!apply) {
    log();
    log("No writes performed. Re-run with --apply to archive.");
    return;
  }
  if (toArchive.length === 0) {
    log();
    log("Nothing to archive.");
    return;
  }

  log();
  log(`Archiving ${toArchive.length} case(s)…`);
  let ok = 0;
  let fail = 0;
  for (const c of toArchive) {
    const r = await archive(c.id);
    if (r.ok) {
      ok++;
    } else {
      fail++;
      log(`  ✗ FAILED case=${c.id.slice(0, 8)}: ${r.error}`);
    }
  }
  log(`Archived: ${ok}   Failed: ${fail}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
