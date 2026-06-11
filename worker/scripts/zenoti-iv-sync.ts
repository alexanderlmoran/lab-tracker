// Zenoti IV → iv_sessions sync runner.
//
// Sibling of zenoti-sync.ts: fetches a day's "IV -" appointments from Zenoti
// (classified via classifyIvService) and POSTs them to the tracker's
// /api/worker/iv-sessions endpoint, which upserts iv_sessions. Idempotent.
//
// Run:
//   cd worker
//   npx tsx scripts/zenoti-iv-sync.ts
//   ZENOTI_DATE=2026-06-09 npx tsx scripts/zenoti-iv-sync.ts
//   ZENOTI_DAYS_AHEAD=1 npx tsx scripts/zenoti-iv-sync.ts   # today + N days
//
// Needs a fresh Zenoti session (storage.json). If you see 401/302, refresh via
// the lab-portal-capture skill and update ZENOTI_STORAGE_PATH.

import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { materializePortalSessions } from "../src/lib/portal-sessions.js";
import { fetchZenotiIvAppointments } from "../src/zenoti/fetch-browser.js";
import type { IvAppointment } from "../src/zenoti/types.js";

loadEnvLocal();
materializePortalSessions(); // on Fly: ZENOTI_SESSION_B64 → temp file → ZENOTI_STORAGE_PATH

const STORAGE_PATH =
  process.env.ZENOTI_STORAGE_PATH ?? "captures/zenoti/20260609-160220/storage.json";
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const DATE = process.env.ZENOTI_DATE ?? new Date().toISOString().slice(0, 10);
const DAYS_AHEAD = Number(process.env.ZENOTI_DAYS_AHEAD ?? "0");

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function syncDate(date: string) {
  log(`fetching Zenoti IV appts for ${date}`);
  const appts = await fetchZenotiIvAppointments({ storagePath: STORAGE_PATH, date });
  log(`  ${appts.length} IV appointment(s) found`);
  for (const a of appts) {
    log(
      `  • ${a.patientFullName} • ${a.serviceName} • kind=${a.kind}` +
        `${a.isAddOn ? " [add-on]" : ""}${a.weber ? " [weber]" : ""} • zenoti=${a.zenotiAppointmentId}`,
    );
  }
  await pushToTracker(appts, date);
}

async function pushToTracker(appts: IvAppointment[], date: string) {
  if (appts.length === 0) {
    log(`nothing to push for ${date}.`);
    return;
  }
  log(`POST → ${BASE}/api/worker/iv-sessions (${appts.length} appts, ${date})`);
  const res = await request(`${BASE}/api/worker/iv-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ appointments: appts, date }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`tracker rejected: ${res.statusCode} ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as { received: number; upserted: number; date: string };
  log(`tracker: received=${json.received} upserted=${json.upserted} date=${json.date}`);
}

async function main() {
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    await syncDate(addDays(DATE, i));
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
