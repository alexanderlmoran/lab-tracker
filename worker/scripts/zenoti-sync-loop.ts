// Long-running Zenoti → tracker sync loop.
//
// Same logic as zenoti-sync.ts (the one-shot), wrapped in an interval. Runs
// as a single Node process so SIGINT/SIGTERM from concurrently / Ctrl+C
// terminate cleanly — no orphan child processes.
//
// Run:
//   npm run dev:zenoti
//   ZENOTI_SYNC_INTERVAL_MS=120000 npm run dev:zenoti

import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { fetchZenotiLabAppointments } from "../src/zenoti/fetch-browser.js";
import type { LabAppointment } from "../src/zenoti/types.js";

loadEnvLocal();

const STORAGE_PATH = "captures/zenoti/20260522-103507/storage.json";
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const INTERVAL_MS = Number(process.env.ZENOTI_SYNC_INTERVAL_MS ?? "60000");
// Pull today + N days forward each tick so future bookings get caught early.
const DAYS_AHEAD = Number(process.env.ZENOTI_DAYS_AHEAD ?? "0");

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] zenoti  ${m}`);

function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type SyncedDateCensus = { date: string; allAppointmentIds: string[] };

async function pushToTracker(
  appts: LabAppointment[],
  syncedDates: SyncedDateCensus[],
): Promise<void> {
  const active = appts.filter((a) => !a.cancelled);
  const cancelledAppointmentIds = appts
    .filter((a) => a.cancelled)
    .map((a) => a.zenotiAppointmentId);
  // Even with zero appointments to upsert/cancel, we still want to POST so
  // the reconciliation pass can clean up hard-deleted cases for the date.
  const res = await request(`${BASE}/api/worker/cases`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      appointments: active,
      cancelledAppointmentIds,
      syncedDates,
    }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`tracker rejected: ${res.statusCode} ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as {
    received: number;
    created: number;
    existing: number;
    cancelledReceived?: number;
    cancelledDeleted?: number;
    reconciledDeleted?: number;
    errors: { zenotiAppointmentId: string; error: string }[];
  };
  if (
    json.created > 0 ||
    (json.cancelledDeleted ?? 0) > 0 ||
    (json.reconciledDeleted ?? 0) > 0 ||
    json.errors.length > 0
  ) {
    log(
      `pushed ${json.received} • +${json.created} new • ${json.existing} existing` +
        ` • cancellations: ${json.cancelledReceived ?? 0} reported / ${json.cancelledDeleted ?? 0} deleted` +
        ` • reconciled: ${json.reconciledDeleted ?? 0} hard-deletions` +
        ` • ${json.errors.length} errors`,
    );
  }
}

async function tick(): Promise<void> {
  try {
    const today = todayLocal();
    const all: LabAppointment[] = [];
    const syncedDates: SyncedDateCensus[] = [];
    for (let i = 0; i <= DAYS_AHEAD; i++) {
      const d = addDays(today, i);
      const appts = await fetchZenotiLabAppointments({
        storagePath: STORAGE_PATH,
        date: d,
        includeCancelled: true, // we need cancellations for auto-archive
      });
      all.push(...appts);
      // Census for the reconciliation pass: every lab appointment ID
      // Zenoti returned for this date. Cases whose ID isn't in here got
      // hard-deleted upstream and need cleanup.
      syncedDates.push({
        date: d,
        allAppointmentIds: appts.map((a) => a.zenotiAppointmentId),
      });
    }
    await pushToTracker(all, syncedDates);
  } catch (err) {
    log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  log(`starting`);
  log(`  tracker:  ${BASE}`);
  log(`  storage:  ${STORAGE_PATH}`);
  log(`  interval: ${INTERVAL_MS}ms, days-ahead=${DAYS_AHEAD}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
