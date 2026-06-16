// IV auto-post LOOP (Fly process). One supervised loop that:
//   • drains the IV post queue every IV_DRAIN_INTERVAL_MS (default 5 min) so
//     staff "Chart & post" clicks post promptly;
//   • runs a PERIODIC sweep every IV_SWEEP_EVERY_MIN (default 60 min) that
//     enqueues IVs which occurred >= IV_SWEEP_MINAGE_MIN ago (default 60) — i.e.
//     a note appears ~1h after each infusion; and
//   • runs a FULL-DAY catch-all sweep (minAge 0) at each IV_SWEEP_TIMES entry
//     (default "17:00,19:30" — 5pm, then a 7:30pm backstop) so the whole day is
//     guaranteed posted by close.
// The sweep's OCCURRED guard means a future appointment is never posted early.
//
// Must run under scripts/pb-egress-entrypoint.sh on Fly (the drain posts to PB,
// which blocks datacenter IPs — see pbdrain/reconcile).
//
// Run:  cd worker && npx tsx scripts/iv-autopost-loop.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, type PbSession } from "../src/uploaders/practicebetter.js";
import { readPbInfusionSeed } from "../src/iv/pc-series.js";
import { reportHeartbeat } from "../src/lib/heartbeat.js";
import { drainIvPosts } from "../src/iv/post-drain.js";

loadEnvLocal();
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USER = process.env.PB_USERNAME;
const PB_PASS = process.env.PB_PASSWORD;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");
if (!PB_USER || !PB_PASS) throw new Error("PB_USERNAME + PB_PASSWORD required");

const SWEEP_TIMES = (process.env.IV_SWEEP_TIMES ?? "17:00,19:30").split(",").map((s) => s.trim()).filter(Boolean);
const SWEEP_EVERY_MIN = Number(process.env.IV_SWEEP_EVERY_MIN ?? 60);
const SWEEP_MINAGE_MIN = Number(process.env.IV_SWEEP_MINAGE_MIN ?? 60);
const SWEEP_DAYS = process.env.IV_SWEEP_DAYS ?? "2";
const DRAIN_MS = Number(process.env.IV_DRAIN_INTERVAL_MS ?? 5 * 60 * 1000);
const RELOGIN_MS = Number(process.env.IV_RELOGIN_MS ?? 3 * 60 * 60 * 1000); // re-login every ~3h (PB sessions expire)
const PC_SEED_EVERY_MIN = Number(process.env.IV_PC_ENRICH_EVERY_MIN ?? 10); // PC series-seed cadence (one-time PB read per patient)

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Cap a promise so a hung external call can NEVER freeze the loop (the lesson
 *  from the consumables incident). The underlying call may still settle in the
 *  background; we just stop awaiting it. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

/** Current "HH:MM" + date (YYYY-MM-DD) in clinic time (America/New_York). */
function nowEastern(): { hm: string; date: string } {
  const tz = "America/New_York";
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return { hm, date };
}

async function runSweep(minAgeMin: number, label: string) {
  const res = await request(`${BASE}/api/worker/iv-post/sweep?days=${SWEEP_DAYS}&minAgeMin=${minAgeMin}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  const txt = await res.body.text();
  if (res.statusCode !== 200) { log(`!! sweep(${label}) ${res.statusCode}: ${txt.slice(0, 150)}`); return; }
  log(`sweep(${label}) → ${txt}`);
}

/** One-time-per-patient PC SERIES SEED: pull PC patients that have no ledger row
 *  yet, read each one's PC count from PB ONCE (readPbInfusionSeed), and seed the
 *  local ledger (iv_infusion_series). After this, the infusion number is owned
 *  locally and assigned at post time — PB is never read for history again.
 *  Ambiguous patients (PB candidates but no confident name match) are NOT seeded
 *  → their post holds for staff (who set the #), never auto-posting a wrong #1.
 *  Caller wraps this in withTimeout so it can never hang the loop. */
async function seedPcSeries(pb: PbSession): Promise<void> {
  const res = await request(`${BASE}/api/worker/iv-pc-history`, { headers: { authorization: `Bearer ${SECRET}` } });
  if (res.statusCode !== 200) { await res.body.text(); return; }
  const { patients } = (await res.body.json()) as {
    patients: Array<{ zenotiGuestId: string; patientFullName: string | null; patientFirstName: string | null; patientLastName: string | null; patientEmail: string | null; patientPhone: string | null }>;
  };
  if (!patients?.length) return;
  const seeds: Array<{ zenotiGuestId: string; lastNumber: number; lastVialCount: string | null; patientFullName: string | null }> = [];
  for (const p of patients) {
    const identity = { fullName: p.patientFullName, firstName: p.patientFirstName, lastName: p.patientLastName, email: p.patientEmail, phone: p.patientPhone };
    const seed = await readPbInfusionSeed(pb, identity);
    if (seed.lastNumber == null) { log(`pc-seed SKIP: "${identity.fullName}" — ${seed.reason}`); continue; }
    seeds.push({ zenotiGuestId: p.zenotiGuestId, lastNumber: seed.lastNumber, lastVialCount: seed.lastVials, patientFullName: identity.fullName });
  }
  if (seeds.length) {
    const r = await request(`${BASE}/api/worker/iv-pc-history`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ seeds }) });
    log(`pc-seed: seeded ${seeds.length} patient(s) → ${r.statusCode}`);
    await r.body.text();
  }
}

async function main() {
  log(`IV auto-post loop up — drain every ${Math.round(DRAIN_MS / 1000)}s, periodic sweep every ${SWEEP_EVERY_MIN}m (≥${SWEEP_MINAGE_MIN}m old), full sweeps at ${SWEEP_TIMES.join(", ")} ET`);
  let pb: PbSession | null = null;
  let pbLoginMs = 0;
  let lastPeriodicMs = 0;
  let lastPcSeedMs = 0;
  const doneToday = new Set<string>(); // "<date> <HH:MM>" full-sweeps already run

  for (;;) {
    try {
      const { hm, date } = nowEastern();
      // Full-day catch-all sweeps at the configured times (5pm, 7:30pm).
      for (const t of SWEEP_TIMES) {
        const key = `${date} ${t}`;
        if (hm >= t && !doneToday.has(key)) {
          await runSweep(0, t);
          doneToday.add(key);
        }
      }
      // Periodic "post ~1h after" sweep (occurred >= minAge ago).
      if (Date.now() - lastPeriodicMs >= SWEEP_EVERY_MIN * 60_000) {
        await runSweep(SWEEP_MINAGE_MIN, `every${SWEEP_EVERY_MIN}m`);
        lastPeriodicMs = Date.now();
      }
      // (Re-)login if we have no session or the current one is aging out.
      if (!pb || Date.now() - pbLoginMs > RELOGIN_MS) {
        pb = await pbLogin(PB_USER!, PB_PASS!);
        pbLoginMs = Date.now();
        log("PB session established");
      }
      // PC series-seed runs BEFORE the drain so a just-synced PC patient gets
      // bootstrapped, then numbered + posted in the SAME cycle (no race). One PB
      // read per patient, ever; HARD timeout cap so it can never hang the loop
      // (the consumables lesson). Throttled; uses the established PB session.
      if (pb && Date.now() - lastPcSeedMs > PC_SEED_EVERY_MIN * 60_000) {
        try {
          await withTimeout(seedPcSeries(pb), 45_000);
          lastPcSeedMs = Date.now();
        } catch (e) {
          log(`pc-seed skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const { processed, authError } = await drainIvPosts(pb);
      if (processed) log(`drained ${processed} job(s)`);
      // A 401 means the PB session expired mid-run — drop it so we re-login next
      // cycle; the failed jobs self-heal when the next sweep re-enqueues them.
      if (authError) { log("PB 401 — re-login next cycle"); pb = null; }
      await reportHeartbeat("ivpost"); // cycle completed → liveness
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`!! cycle error: ${msg}`);
      pb = null; // re-login next cycle (covers expired PB session)
      await reportHeartbeat("ivpost", { status: "error", error: msg });
    }
    await sleep(DRAIN_MS);
  }
}
main().catch((e) => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
