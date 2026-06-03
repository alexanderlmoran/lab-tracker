// Zenoti → tracker sync runner.
//
// Fetches today's (or DATE override) lab appointments from Zenoti using the
// captured cookie session, then POSTs them to the tracker's
// /api/worker/cases endpoint. Idempotent — re-running just confirms existing
// rows.
//
// Run:
//   cd worker
//   npx tsx scripts/zenoti-sync.ts
//   ZENOTI_DATE=2026-05-22 npx tsx scripts/zenoti-sync.ts
//   ZENOTI_DAYS_AHEAD=7 npx tsx scripts/zenoti-sync.ts   # poll today + N days
//
// If you see auth errors, re-run the capture skill to refresh storage.json
// and update STORAGE_PATH below.

import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { materializePortalSessions } from "../src/lib/portal-sessions.js";
import { fetchZenotiLabAppointments } from "../src/zenoti/fetch-browser.js";
import type { LabAppointment } from "../src/zenoti/types.js";

loadEnvLocal();
materializePortalSessions(); // on Fly: ZENOTI_SESSION_B64 → temp file → ZENOTI_STORAGE_PATH

// On Fly, ZENOTI_STORAGE_PATH is set from the secret; locally it falls back to
// the most recent captured session (refresh via the lab-portal-capture skill).
const STORAGE_PATH =
  process.env.ZENOTI_STORAGE_PATH ?? "captures/zenoti/20260522-103507/storage.json";
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

async function syncDate(date: string): Promise<LabAppointment[]> {
  log(`fetching Zenoti lab appts for ${date}`);
  const appts = await fetchZenotiLabAppointments({
    storagePath: STORAGE_PATH,
    date,
  });
  log(`  ${appts.length} lab appointment(s) found`);
  for (const a of appts) {
    log(`  • ${a.patientFullName} • ${a.labName} • ${a.serviceName} • zenoti=${a.zenotiAppointmentId}`);
  }
  return appts;
}

async function pushToTracker(appts: LabAppointment[]) {
  if (appts.length === 0) {
    log("nothing to push.");
    return;
  }
  log(`POST → ${BASE}/api/worker/cases (${appts.length} appts)`);
  const res = await request(`${BASE}/api/worker/cases`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ appointments: appts }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`tracker rejected: ${res.statusCode} ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as {
    received: number;
    created: number;
    existing: number;
    errors: { zenotiAppointmentId: string; error: string }[];
    results: { zenotiAppointmentId: string; caseId: string; created: boolean }[];
  };
  log(`tracker: received=${json.received} created=${json.created} existing=${json.existing} errors=${json.errors.length}`);
  for (const r of json.results) {
    log(`  ${r.created ? "+NEW" : " dup"}  case=${r.caseId}  zenoti=${r.zenotiAppointmentId}`);
  }
  for (const e of json.errors) {
    log(`  !!ERR  zenoti=${e.zenotiAppointmentId}: ${e.error}`);
  }
}

async function main() {
  const all: LabAppointment[] = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = addDays(DATE, i);
    const appts = await syncDate(d);
    all.push(...appts);
  }
  await pushToTracker(all);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
