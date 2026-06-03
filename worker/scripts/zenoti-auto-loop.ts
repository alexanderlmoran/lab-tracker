// Zenoti auto-refresh sync loop. Runs as an always-on Fly machine.
//
//  - Logs in headless on startup, again every ZENOTI_RELOGIN_MS (~20h, before
//    the ~24h cookie expiry), and again on any sync error (likely a dead cookie).
//  - Every ZENOTI_LOOP_INTERVAL_MS (default 3 min) fetches lab appointments for
//    TODAY + ZENOTI_DAYS_AHEAD days (default 1 = today + tomorrow) and UPSERTs
//    them into the tracker (/api/worker/cases, idempotent by zenoti_appointment_id).
//
// Needs: ZENOTI_USERNAME/PASSWORD, TRACKER_BASE_URL, WORKER_SHARED_SECRET.

import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { zenotiLogin } from "../src/zenoti/login.js";
import { fetchZenotiLabAppointments } from "../src/zenoti/fetch-browser.js";
import type { LabAppointment } from "../src/zenoti/types.js";

loadEnvLocal();

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const STORAGE = process.env.ZENOTI_STORAGE_PATH ?? "/tmp/zenoti-session.json";
const INTERVAL_MS = Number(process.env.ZENOTI_LOOP_INTERVAL_MS ?? "180000"); // 3 min
const DAYS_AHEAD = Number(process.env.ZENOTI_DAYS_AHEAD ?? "1"); // today + tomorrow
const RELOGIN_MS = Number(process.env.ZENOTI_RELOGIN_MS ?? String(20 * 60 * 60 * 1000)); // 20h

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastLoginAt = 0;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function refreshSession(): Promise<void> {
  const n = await zenotiLogin(STORAGE);
  lastLoginAt = Date.now();
  log(`logged in — ${n} cookies → ${STORAGE}`);
}

async function pushToTracker(appts: LabAppointment[]): Promise<void> {
  if (appts.length === 0) return;
  const res = await request(`${BASE}/api/worker/cases`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ appointments: appts }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`tracker rejected ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { received: number; created: number; existing: number; errors: unknown[] };
  log(`tracker: received=${json.received} created=${json.created} existing=${json.existing} errors=${json.errors.length}`);
}

async function syncOnce(): Promise<void> {
  const all: LabAppointment[] = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const date = addDays(today(), i);
    const appts = await fetchZenotiLabAppointments({ storagePath: STORAGE, date });
    all.push(...appts);
  }
  await pushToTracker(all);
}

async function main() {
  log(`zenoti-auto-loop: every ${INTERVAL_MS}ms, today+${DAYS_AHEAD}d, relogin every ${RELOGIN_MS}ms`);
  await refreshSession();
  for (;;) {
    try {
      if (Date.now() - lastLoginAt > RELOGIN_MS) await refreshSession();
      await syncOnce();
    } catch (err) {
      log(`sync error: ${err instanceof Error ? err.message : String(err)} — re-logging in`);
      try {
        await refreshSession();
      } catch (e2) {
        log(`relogin failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
