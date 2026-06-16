// Report a worker loop's liveness to the app's heartbeat sink
// (/api/worker/heartbeat → lab_scraper_status). Best-effort by design: a
// heartbeat failure must NEVER throw or hang the loop it's reporting for, so
// every error is swallowed and the POST is hard-timeout-capped. Reads
// TRACKER_BASE_URL + WORKER_SHARED_SECRET from env (call loadEnvLocal() first).

import { request } from "undici";

/** Fire a heartbeat for `key` (e.g. "scrape-loop", "scrape:access", "ivpost").
 *  status defaults to "ok"; pass {status:"error", error} on a failed cycle. */
export async function reportHeartbeat(
  key: string,
  opts: { status?: "ok" | "error"; error?: string; statusCode?: number } = {},
): Promise<void> {
  const BASE = process.env.TRACKER_BASE_URL;
  const SECRET = process.env.WORKER_SHARED_SECRET;
  if (!BASE || !SECRET) return; // not configured → silently skip
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await request(`${BASE}/api/worker/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ key, status: opts.status ?? "ok", error: opts.error, statusCode: opts.statusCode }),
        signal: ac.signal,
      });
      await res.body.text().catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // swallow — liveness reporting must not affect the loop
  }
}
