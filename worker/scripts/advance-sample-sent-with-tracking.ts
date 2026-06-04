// Advance to "Sample Sent" every active card that has a tracking # but is still
// sitting in "untouched" (step1 not ticked). These are cards where tracking was
// entered via the old edit form, which didn't auto-advance step 1 — so a card
// with a real shipment looks like nothing's happened.
//
// Rule: active (not archived/deleted), tracking_number set, step1_sample_sent
// false. No emails fire (debug advance-step1 is silent).
//
// Default is preview. Add --apply to write.
//   cd worker
//   npx tsx scripts/advance-sample-sent-with-tracking.ts            # preview
//   npx tsx scripts/advance-sample-sent-with-tracking.ts --apply    # apply
//
// NOTE: needs the prod app to have the debug `advance-step1` action deployed.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const apply = process.argv.slice(2).includes("--apply");
const log = (m = "") => console.log(m);

type Case = {
  id: string;
  patient_name: string;
  lab_name: string;
  tracking_number: string | null;
  step1_sample_sent: boolean;
  archived_at: string | null;
  deleted_at: string | null;
};

async function fetchAll(): Promise<Case[]> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?deleted=null&limit=all`;
  const res = await request(url, { method: "GET", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { cases: Case[] };
  return json.cases ?? [];
}

async function advance(id: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?id=${encodeURIComponent(id)}&action=advance-step1`;
  const res = await request(url, { method: "PATCH", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.statusCode === 200 && !!body.ok, error: body.error };
}

async function main() {
  log("─".repeat(84));
  log(`ADVANCE "SAMPLE SENT" for tracked-but-untouched cards — ${apply ? "APPLY" : "PREVIEW"}`);
  log("─".repeat(84));

  const all = await fetchAll();
  const targets = all.filter(
    (c) => !c.archived_at && !c.deleted_at && c.tracking_number && !c.step1_sample_sent,
  );

  log(`Active cases: ${all.length}   |   tracked but in 'untouched': ${targets.length}`);
  log();
  for (const c of targets) {
    log(`  ${c.id.slice(0, 8)}  ${c.lab_name.padEnd(16)} trk=${(c.tracking_number ?? "").padEnd(20)} ${c.patient_name}`);
  }

  if (!apply) {
    log();
    log("No writes performed. Re-run with --apply to advance.");
    return;
  }
  if (targets.length === 0) {
    log("\nNothing to advance.");
    return;
  }

  log(`\nAdvancing ${targets.length}…`);
  let ok = 0;
  let fail = 0;
  for (const c of targets) {
    const r = await advance(c.id);
    if (r.ok) ok++;
    else {
      fail++;
      log(`  ✗ ${c.id.slice(0, 8)}: ${r.error}`);
    }
  }
  log(`Advanced: ${ok}   Failed: ${fail}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
