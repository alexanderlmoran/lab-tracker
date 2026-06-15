// Delete one PB note + reset its session to pending (un-link). For cleaning up an
// erroneously auto-posted note. Run: cd worker && npx tsx scripts/iv-del-one.ts <noteId> <sessionId>
import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { deleteSessionNote } from "../src/uploaders/pb-sessionnotes.js";
loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
async function rest(method: string, path: string, body?: unknown) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { method, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=minimal" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (res.statusCode >= 300) throw new Error(`${method} ${path} ${res.statusCode}`); else await res.body.text();
}
async function main() {
  const [noteId, sessionId] = process.argv.slice(2);
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const ok = await deleteSessionNote(pb, noteId).catch((e) => { console.log("delete err", e.message); return false; });
  await rest("PATCH", `iv_sessions?id=eq.${sessionId}`, { pb_note_id: null, pb_client_record_id: null, charting_status: "pending" });
  await rest("DELETE", `iv_post_jobs?session_id=eq.${sessionId}`);
  console.log(`${ok ? "🗑 deleted" : "⚠ not deleted"} note=${noteId}; session ${sessionId} → pending`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
