// IV note post worker — ONE drain pass. Claims charted IV sessions, grades the
// PB patient match, and auto-posts the note when score >= 95 (else holds). The
// drain logic lives in src/iv/post-drain.ts (shared with the scheduled loop).
//
// Run:  cd worker && npx tsx scripts/iv-post-worker.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { drainIvPosts } from "../src/iv/post-drain.js";

loadEnvLocal();
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  if (!process.env.PB_USERNAME || !process.env.PB_PASSWORD) throw new Error("PB_USERNAME + PB_PASSWORD required");
  const pb = await pbLogin(process.env.PB_USERNAME, process.env.PB_PASSWORD);
  log("PB session established");
  const n = await drainIvPosts(pb);
  log(`done; processed ${n} job(s)`);
}
main().catch((e) => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
