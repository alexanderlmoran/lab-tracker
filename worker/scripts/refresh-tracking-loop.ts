// FedEx tracking refresh loop. Runs as an always-on Fly machine.
//
// Vercel Hobby caps crons at once/day, but the FedEx status (and the
// auto-advance to "Sample Sent" on in-transit) is most useful a few times a
// day. So the worker — which has no plan cap — pokes the app's existing
// refresh endpoint every TRACKING_LOOP_INTERVAL_MS. The endpoint accepts the
// worker's shared secret (no new secret needed). See docs/PLAYBOOK.md.
//
// Needs: TRACKER_BASE_URL, WORKER_SHARED_SECRET.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const INTERVAL_MS = Number(process.env.TRACKING_LOOP_INTERVAL_MS ?? String(2 * 60 * 60 * 1000)); // 2h

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tick(): Promise<void> {
  try {
    const res = await request(`${BASE}/api/cron/refresh-tracking`, {
      method: "GET",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = (await res.body.json().catch(() => ({}))) as {
      ok?: boolean;
      polled?: number;
      updated?: number;
      errors?: number;
      error?: string;
    };
    if (res.statusCode === 200 && body.ok) {
      log(`refresh-tracking: polled=${body.polled ?? 0} updated=${body.updated ?? 0} errors=${body.errors ?? 0}`);
    } else {
      log(`refresh-tracking failed: ${res.statusCode} ${body.error ?? ""}`);
    }
  } catch (err) {
    log(`refresh-tracking error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  log(`refresh-tracking-loop: every ${INTERVAL_MS}ms`);
  // small startup delay so a deploy's app + worker don't thundering-herd
  await sleep(5000);
  for (;;) {
    await tick();
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
