// Fire the FedEx pickup test trigger on the deployed app (which holds the
// pickup creds) and print the result. Books a REAL pickup — cancel it in the
// FedEx portal afterward.
//   cd worker
//   npx tsx scripts/test-fedex-pickup.ts            # ready tomorrow
//   npx tsx scripts/test-fedex-pickup.ts 2026-06-08 # ready a specific date

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");

async function main() {
  const date = process.argv[2];
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  const res = await request(`${BASE}/api/worker/debug/fedex-pickup-test${qs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  const body = await res.body.json().catch(() => ({}));
  console.log("HTTP", res.statusCode);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
