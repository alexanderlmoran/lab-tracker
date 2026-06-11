// Calls the IV auto-post sweep endpoint, which enqueues a post job for every
// occurred-but-unposted IV (so notes never go missing). Pair with
// iv-post-worker.ts on the Fly schedule: sweep (enqueue) → worker (drain/post).
//
// Run:  cd worker && npx tsx scripts/iv-post-sweep.ts            (enqueue)
//       IV_SWEEP_DRY=1 npx tsx scripts/iv-post-sweep.ts          (report only)
//       IV_SWEEP_DAYS=3 npx tsx scripts/iv-post-sweep.ts         (window)

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");

const days = process.env.IV_SWEEP_DAYS ?? "2";
const dry = process.env.IV_SWEEP_DRY === "1";

async function main() {
  const res = await request(`${BASE}/api/worker/iv-post/sweep?days=${days}${dry ? "&dryRun=1" : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  const txt = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`sweep ${res.statusCode}: ${txt.slice(0, 200)}`);
  console.log(`[${new Date().toISOString()}] sweep ${dry ? "(dry) " : ""}→ ${txt}`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
