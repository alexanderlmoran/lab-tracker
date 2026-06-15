// One-off cleanup: remove the 4 wrong/duplicate IV notes created by the
// 2026-06-15 re-enqueue (base-IV cocktail + duplicate of an existing note), and
// reset their sessions so staff re-chart (or, for the already-charted one, skip).
// Safe to run only AFTER the base-IV fix + dup-guard are deployed.
//
// Run: cd worker && npx tsx scripts/iv-cleanup-baddupes.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { deleteSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;

const ITEMS = [
  { note: "6a301c95b75721ada2f4283c", session: "25804f79-9d1e-41e2-99d3-b257d50ad7e1", status: "skipped", who: "Jenny Dashevsky PC (dup of existing Infusion #3)" },
  { note: "6a301c98b75721ada2f42861", session: "f6739783-776e-4aac-8be5-8f51224f352e", status: "pending", who: "Keisha Lightbourne Custom #1 (wrong: Immune Boost content)" },
  { note: "6a301c9ab75721ada2f42864", session: "936db585-6479-4cbb-904b-4b4373dd5a89", status: "pending", who: "Keisha Lightbourne Custom #2 (wrong + dup)" },
  { note: "6a301c9db75721ada2f42869", session: "0ef13038-8c8d-4ec6-b6c6-595291da2115", status: "pending", who: "Chris Clark Curcumin (wrong: Immune Boost content)" },
];

async function rest(method: string, path: string, body?: unknown) {
  const res = await request(`${SUPA}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=minimal" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${method} ${path} ${res.statusCode}: ${txt.slice(0, 150)}`);
}

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  for (const it of ITEMS) {
    let deleted = false;
    try { deleted = await deleteSessionNote(pb, it.note); } catch (e) { console.log(`  ⚠ delete failed ${it.note}: ${e instanceof Error ? e.message : e}`); }
    // unlink the deleted note + reset status; drop the post job so it re-evaluates fresh.
    await rest("PATCH", `iv_sessions?id=eq.${it.session}`, { pb_note_id: null, pb_client_record_id: null, charting_status: it.status });
    await rest("DELETE", `iv_post_jobs?session_id=eq.${it.session}`);
    console.log(`  ${deleted ? "🗑  deleted" : "⚠  not deleted"}  ${it.note}  → session ${it.status.padEnd(7)} | ${it.who}`);
  }
  console.log("\n  done.");
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
