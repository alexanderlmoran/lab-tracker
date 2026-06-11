// IV auto-post LOOP (Fly process). Two jobs in one supervised loop:
//   • drains the IV post queue every IV_DRAIN_INTERVAL_MS (default 5 min) so
//     staff "Chart & post" clicks post promptly; and
//   • once per day at 5pm America/New_York, runs the auto-post SWEEP so a note
//     never goes missing — every occurred-but-unposted IV is enqueued, then the
//     same drain posts the >=95 matches (flagged incomplete) and holds the rest.
//
// Must run under scripts/pb-egress-entrypoint.sh on Fly (the drain posts to PB,
// which blocks datacenter IPs — see pbdrain/reconcile).
//
// Run:  cd worker && npx tsx scripts/iv-autopost-loop.ts
// Env:  IV_SWEEP_HOUR_ET (default 17), IV_SWEEP_DAYS (default 2),
//       IV_DRAIN_INTERVAL_MS (default 300000)

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, type PbSession } from "../src/uploaders/practicebetter.js";
import { drainIvPosts } from "../src/iv/post-drain.js";

loadEnvLocal();
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USER = process.env.PB_USERNAME;
const PB_PASS = process.env.PB_PASSWORD;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");
if (!PB_USER || !PB_PASS) throw new Error("PB_USERNAME + PB_PASSWORD required");

const SWEEP_HOUR_ET = Number(process.env.IV_SWEEP_HOUR_ET ?? 17); // 5pm Eastern
const SWEEP_DAYS = process.env.IV_SWEEP_DAYS ?? "2";
const DRAIN_MS = Number(process.env.IV_DRAIN_INTERVAL_MS ?? 5 * 60 * 1000);

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current hour (0-23) + date (YYYY-MM-DD) in clinic time (America/New_York). */
function nowEastern(): { hour: number; date: string } {
  const tz = "America/New_York";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return { hour: hour % 24, date };
}

async function runSweep() {
  const res = await request(`${BASE}/api/worker/iv-post/sweep?days=${SWEEP_DAYS}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  const txt = await res.body.text();
  if (res.statusCode !== 200) { log(`!! sweep ${res.statusCode}: ${txt.slice(0, 150)}`); return; }
  log(`sweep → ${txt}`);
}

async function main() {
  log(`IV auto-post loop up — drain every ${Math.round(DRAIN_MS / 1000)}s, sweep daily at ${SWEEP_HOUR_ET}:00 ET`);
  let pb: PbSession | null = null;
  let lastSweptDate: string | null = null;

  for (;;) {
    try {
      const { hour, date } = nowEastern();
      // Daily 5pm ET auto-post sweep (enqueue the day's unposted IVs).
      if (hour >= SWEEP_HOUR_ET && lastSweptDate !== date) {
        await runSweep();
        lastSweptDate = date;
      }
      if (!pb) { pb = await pbLogin(PB_USER!, PB_PASS!); log("PB session established"); }
      const n = await drainIvPosts(pb);
      if (n) log(`drained ${n} job(s)`);
    } catch (e) {
      log(`!! cycle error: ${e instanceof Error ? e.message : e}`);
      pb = null; // re-login next cycle (covers expired PB session)
    }
    await sleep(DRAIN_MS);
  }
}
main().catch((e) => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
