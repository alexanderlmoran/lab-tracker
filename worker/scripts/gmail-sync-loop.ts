// Always-on Gmail inbox sync loop (Fly `gmailsync` process). POSTs the app's
// /api/worker/gmail-sync every GMAIL_SYNC_LOOP_MS (default 2 min) so lab
// emails surface in the inbox — and KK results auto-forward — without anyone
// clicking "Sync now". The app does the actual work (Gmail OAuth tokens +
// Claude parse live there); this loop is just the scheduler, like tracking.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { reportHeartbeat } from "../src/lib/heartbeat.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL and WORKER_SHARED_SECRET are required");

const intervalMs = Number(process.env.GMAIL_SYNC_LOOP_MS ?? String(2 * 60 * 1000));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tick(): Promise<void> {
  const res = await request(`${BASE}/api/worker/gmail-sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    // The route parses with Claude; allow a slow full sync.
    headersTimeout: 5 * 60 * 1000,
    bodyTimeout: 5 * 60 * 1000,
  });
  const body = (await res.body.json()) as {
    ok: boolean;
    processed?: number;
    skipped?: number;
    errors?: number;
    error?: string;
  };
  if (!body.ok) {
    // "Gmail not connected" (expired/revoked OAuth) returns ok:false — count it as
    // a FAILURE, not a quiet skip, so the watchdog flags a dead token instead of
    // the loop looping forever doing nothing (inbox ingest + KK forward stop).
    const err = body.error ?? `status ${res.statusCode}`;
    log(`sync not ok: ${err}`);
    await reportHeartbeat("gmailsync", { status: "error", error: err });
    return;
  }
  if ((body.processed ?? 0) > 0 || (body.errors ?? 0) > 0) {
    log(`processed ${body.processed}, skipped ${body.skipped}, errors ${body.errors}`);
  }
  await reportHeartbeat("gmailsync");
}

async function main() {
  log(`gmail sync loop: every ${intervalMs}ms → ${BASE}`);
  await sleep(5000); // let siblings settle after a deploy
  for (;;) {
    try {
      await tick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`tick error: ${msg}`);
      await reportHeartbeat("gmailsync", { status: "error", error: msg });
    }
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
