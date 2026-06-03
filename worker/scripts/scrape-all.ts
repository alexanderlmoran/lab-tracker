// Scheduled scrape trigger. Pokes /run/:lab for each credential-login portal so
// results land in the tracker's Pending Upload queue automatically (a human
// still Approves before anything reaches PB). Run by a Fly scheduled machine
// (hourly, --restart no). Hits the worker's own public URL, which auto-starts
// the scale-to-zero HTTP worker. Portals needing a session file (Genova) or a
// multi-step flow (Vibrant) are intentionally excluded — set SCRAPE_LABS to
// override.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const BASE = process.env.WORKER_SELF_URL ?? "https://lab-tracker-worker.fly.dev";
const SECRET = process.env.WORKER_SHARED_SECRET;
const LABS = (process.env.SCRAPE_LABS ?? "access,cyrex,spectracell,glycanage,doctorsdata")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  log(`scrape-all → ${LABS.join(", ")} via ${BASE}`);
  for (const lab of LABS) {
    try {
      const res = await request(`${BASE}/run/${lab}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        headersTimeout: 300_000,
        bodyTimeout: 300_000,
      });
      const body = await res.body.text();
      log(`${lab}: ${res.statusCode} ${body.slice(0, 200)}`);
    } catch (e) {
      log(`${lab}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log("scrape-all done");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
