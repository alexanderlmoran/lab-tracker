// Manual one-off Zenoti login (writes a fresh storage.json). The auto-refresh
// loop (zenoti-auto-loop.ts) does this on a schedule; this is for ad-hoc use.
//
// Run: ZENOTI_STORAGE_PATH=/tmp/z.json npx tsx scripts/zenoti-login.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { zenotiLogin } from "../src/zenoti/login.js";

loadEnvLocal();

const OUT = process.env.ZENOTI_STORAGE_PATH ?? "captures/zenoti/auto/storage.json";

zenotiLogin(OUT)
  .then((n) => console.log(`[${new Date().toISOString()}] LOGIN OK — ${n} cookies → ${OUT}`))
  .catch((e) => {
    console.error(`[${new Date().toISOString()}] LOGIN FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
