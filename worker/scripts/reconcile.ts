// Reconciliation ENGINE (the closed loop). Dry by default; --apply to act.
//
// Per stuck case:
//   1. Already on PB (high) → advance step5 → card moves to Complete Uploaded.
//   2. Not on PB → search the portal (skipping dismissed_refs):
//        • no candidate / only stale (>WINDOW days off the draw) → keep searching
//          (no human pester — the right result hasn't populated yet)
//        • a date-plausible candidate → download → grade →
//            grade ≥90 → stage + AUTO-APPROVE (pb-worker posts → Complete Uploaded)
//            grade <90 → stage in Pending Upload, FLAG for Nadia + Alex
//
//   cd worker
//   npx tsx scripts/reconcile.ts                          # Fereshteh, dry
//   npx tsx scripts/reconcile.ts --patient=all --apply    # whole Access set, live
//   npx tsx scripts/reconcile.ts --lab=all --patient=all  # every portal
//
// --lab=all sweeps every portal. The PB-dedup half (advance already-on-PB) runs
// for ALL labs; the portal search→grade→≥90-post half runs for labs whose
// scraper exposes probeByName (Access today; others as they gain it — see the
// scraperByLab registry below).

import { request } from "undici";
import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { reportHeartbeat } from "../src/lib/heartbeat.js";

loadEnvLocal();

const { pbLogin, findPbPatient, listAllConsultantLabRequests, isPbAuthError } = await import(
  "../src/uploaders/practicebetter.js"
);
const { classifyCase } = await import("../src/backfill/engine.js");
const { gradeCapture } = await import("../src/recon/grade.js");
const { postResultReady, postEngineRun, postCoverageSnapshot } = await import("../src/tracker-client.js");

type BackfillCaseT = import("../src/backfill/engine.js").BackfillCase;
type ProbeCandidateT = import("../src/scrapers/base.js").ProbeCandidate;
type OpenCaseT = import("../src/tracker-client.js").OpenCase;
type LabScraperT = import("../src/scrapers/base.js").LabScraper;

// Per-lab scraper registry. The hand-written scraper objects each expose run()
// (download by labExternalRef) and OPTIONALLY probeByName() (patient search).
// PB-dedup (advance already-on-PB) is portal-agnostic and runs for every lab;
// the portal search→grade→post path runs only for labs whose scraper exposes
// probeByName (Access today; others as they gain it). One bad/uninstallable
// scraper module must not sink the others, so each import is isolated.
const SCRAPER_MODULES: Array<[string, string]> = [
  ["../src/scrapers/access.js", "accessScraper"],
  ["../src/scrapers/cyrex.js", "cyrexScraper"],
  ["../src/scrapers/spectracell.js", "spectracellScraper"],
  ["../src/scrapers/genova.js", "genovaScraper"],
  ["../src/scrapers/glycanage.js", "glycanageScraper"],
  ["../src/scrapers/doctorsdata.js", "doctorsdataScraper"],
  ["../src/scrapers/vibrant.js", "vibrantScraper"],
];
const scraperByLab = new Map<string, LabScraperT>();
for (const [path, name] of SCRAPER_MODULES) {
  try {
    const mod = (await import(path)) as Record<string, LabScraperT | undefined>;
    const s = mod[name];
    if (s?.labName) scraperByLab.set(s.labName.toLowerCase(), s);
  } catch (err) {
    console.log(`(reconcile: scraper ${name} unavailable: ${err instanceof Error ? err.message : err})`);
  }
}

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET required");
if (!PB_USERNAME || !PB_PASSWORD) throw new Error("PB_USERNAME / PB_PASSWORD required");

const argv = process.argv.slice(2);
const patientArg = argv.find((a) => a.startsWith("--patient="))?.split("=")[1] ?? "Fereshteh Krasowski";
const labArg = argv.find((a) => a.startsWith("--lab="))?.split("=")[1] ?? "Access";
const apply = argv.includes("--apply");
const loop = argv.includes("--loop");
const log = (m = "") => console.log(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The PB egress runs through a residential Tailscale exit node (a clinic laptop)
// whose path can briefly flap, surfacing as "Proxy response (500) when HTTP
// Tunneling" on a PB call. The cycle's FIRST PB calls (login + the big labrequest
// pull) happen before the per-patient try/catch, so a single flap there would
// abort the whole sweep until the next interval. Retry transient tunnel/network
// failures a few times so a brief flap doesn't cost hours.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5, delayMs = 6000): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /Tunneling|proxy|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|fetch failed|terminated|other side closed|UND_ERR/i.test(msg);
      if (!transient || i === attempts) {
        log(`  (${label} failed${transient ? ` after ${attempts} tries` : ""}: ${msg.slice(0, 80)})`);
        throw err;
      }
      log(`  (${label} attempt ${i}/${attempts} transient tunnel error, retry in ${delayMs / 1000}s)`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

// Auto-post threshold (default 90 = the grader's line). Env-overridable so
// auto-posting to PB can be held OFF entirely — set RECONCILE_AUTOPOST_THRESHOLD
// = 101 and every capture flags for human review instead — until the first live
// auto-posts have been eyeballed, then lower it back to 90.
const AUTOPOST_THRESHOLD = Number(process.env.RECONCILE_AUTOPOST_THRESHOLD ?? "90");

// Only stage a candidate whose collection date is within this many days of the
// case's draw date — anything older is almost certainly a different lab, so we
// keep searching rather than pester a human with it. Matches the scraper's
// inbox window. Cases with no draw date skip the gate (graded on identity only).
const WINDOW_DAYS = 45;

type TrackerCase = {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  patient_email: string | null;
  lab_name: string;
  collection_date: string | null;
  lab_external_ref: string | null;
  zenoti_appointment_id: string | null;
  dismissed_refs: string[] | null;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step3_partial_uploaded: boolean;
  step4_complete_received: boolean;
  step5_complete_uploaded: boolean;
  archived_at: string | null;
  created_at: string;
};

async function fetchCases(query: string, lab: string): Promise<TrackerCase[]> {
  const q = query === "all" ? "" : `q=${encodeURIComponent(query)}&`;
  // limit=all → full pagination; without it the endpoint caps at 50 and we'd
  // silently miss cases (and filtering to one lab afterward makes it worse).
  const url = `${TRACKER_BASE}/api/worker/debug/cases?${q}deleted=null&limit=all`;
  const res = await request(url, { method: "GET", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { ok: boolean; cases: TrackerCase[] };
  const allLabs = lab.toLowerCase() === "all";
  return (json.cases ?? []).filter(
    (c) =>
      c.step1_sample_sent &&
      !c.step5_complete_uploaded &&
      !c.archived_at &&
      (allLabs || c.lab_name?.toLowerCase() === lab.toLowerCase()),
  );
}

function toBackfillCase(c: TrackerCase): BackfillCaseT {
  return {
    caseId: c.id,
    patientName: c.patient_name,
    patientDob: c.patient_dob,
    labName: c.lab_name,
    collectionDate: c.collection_date,
    createdAt: c.created_at,
    zenotiAppointmentId: c.zenoti_appointment_id,
    labExternalRef: c.lab_external_ref,
    panelHint: null,
    step1: c.step1_sample_sent,
    step2: c.step2_partial_received,
    step3: c.step3_partial_uploaded,
    step4: c.step4_complete_received,
    step5: c.step5_complete_uploaded,
  };
}

function toOpenCase(c: TrackerCase, forceRef: string): OpenCaseT {
  return {
    caseId: c.id,
    patientName: c.patient_name,
    patientDob: c.patient_dob,
    patientEmail: c.patient_email ?? "",
    labName: c.lab_name,
    labExternalRef: forceRef, // force the scraper to download THIS accession
    sampleSentAt: c.collection_date,
    trackingDeliveredAt: null,
    expectedResultAtMin: null,
    expectedResultAtMax: null,
    dismissedRefs: c.dismissed_refs ?? [],
  };
}

function daysOff(anchorIso: string | null, collMMDDYYYY: string | null): number | null {
  if (!anchorIso || !collMMDDYYYY) return null;
  const m = collMMDDYYYY.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const coll = Date.parse(`${year}-${m[1]}-${m[2]}T00:00:00Z`);
  const anchor = Date.parse(anchorIso.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(coll) || Number.isNaN(anchor)) return null;
  return Math.abs(coll - anchor) / 86_400_000;
}

function bestCandidate(c: TrackerCase, cands: ProbeCandidateT[]): ProbeCandidateT | null {
  const dismissed = new Set(c.dismissed_refs ?? []);
  const live = cands.filter((x) => !x.ref || !dismissed.has(x.ref));
  if (live.length === 0) return null;
  const ready = live.filter((x) => x.status?.toLowerCase().includes("complete"));
  const pool = ready.length ? ready : live;
  if (c.collection_date) {
    return pool
      .map((x) => ({ x, off: daysOff(c.collection_date, x.collectionDate) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.off - b.off)[0].x;
  }
  return pool[0];
}

async function advanceStep5(id: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${TRACKER_BASE}/api/worker/debug/cases?id=${encodeURIComponent(id)}&action=advance-step5`;
  const res = await request(url, { method: "PATCH", headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.statusCode === 200 && !!body.ok, error: body.error };
}

async function runOnce() {
  log("─".repeat(84));
  log(`RECONCILE ENGINE — lab=${labArg} patient=${patientArg}  ${apply ? "APPLY (LIVE)" : "DRY (no writes)"}`);
  log("─".repeat(84));

  const session = await withRetry("pbLogin", () => pbLogin(PB_USERNAME!, PB_PASSWORD!));
  const cases = await fetchCases(patientArg, labArg);
  log(`Stuck cases (lab=${labArg}): ${cases.length}\n`);
  if (cases.length === 0) return;

  // Pull the full PB labrequest list ONCE and filter per patient in memory.
  // (Re-fetching 2000 rows per patient doesn't scale to --lab=all and hammers
  // PB's rate limit.)
  const allPbReqs = await withRetry("listAllConsultantLabRequests", () =>
    listAllConsultantLabRequests(session, { limit: 2000 }),
  );

  const browser = await chromium.launch({ headless: true });
  const byPatient = new Map<string, TrackerCase[]>();
  for (const c of cases) {
    const k = c.patient_name.trim().toLowerCase();
    byPatient.set(k, [...(byPatient.get(k) ?? []), c]);
  }

  const tally = { advanced: 0, autoposted: 0, flagged: 0, searching: 0, errors: 0 };

  try {
    for (const [, plist] of byPatient) {
      // Isolate each patient: a transient PB/portal failure for one shouldn't
      // abort the whole --lab=all sweep (the next interval is hours away).
      try {
      const first = plist[0];
      const pbPatient = await withRetry("findPbPatient", () =>
        findPbPatient(session, first.patient_name, first.patient_dob ?? undefined),
      );
      const pbReqs = pbPatient ? allPbReqs.filter((lr) => lr.clientRecord?.id === pbPatient.id) : [];

      // Probe each portal this patient has stuck cases in (cache per lab). Only
      // labs whose scraper exposes probeByName get a portal search; the rest
      // fall through to PB-dedup-only ("keep searching").
      const labsForPatient = new Set(plist.map((c) => c.lab_name?.toLowerCase() ?? ""));
      const candsByLab = new Map<string, ProbeCandidateT[]>();
      for (const labKey of labsForPatient) {
        const scraper = scraperByLab.get(labKey);
        if (!scraper?.probeByName) continue;
        try {
          candsByLab.set(labKey, await scraper.probeByName(browser, first.patient_name, first.patient_dob));
        } catch (err) {
          log(`  ⚠ ${first.patient_name} [${labKey}]: portal search failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      const portalSummary = [...candsByLab].map(([k, v]) => `${k}=${v.length}`).join(" ") || "—";
      log(`▸ ${first.patient_name}  pb=${pbReqs.length}  portal: ${portalSummary}`);

      for (const c of plist) {
        const labKey = c.lab_name?.toLowerCase() ?? "";
        const scraper = scraperByLab.get(labKey);

        // 1. Already on PB → advance (portal-agnostic — runs for every lab).
        const decision = classifyCase(toBackfillCase(c), pbReqs);
        if (decision.action === "already-on-pb" && decision.confidence === "high") {
          if (apply) {
            const r = await advanceStep5(c.id);
            if (!r.ok) { tally.errors++; log(`    ✗ ${c.id.slice(0, 8)} advance failed: ${r.error}`); continue; }
          }
          tally.advanced++;
          log(`    • ${c.id.slice(0, 8)} → ON PB (high) → ${apply ? "ADVANCED" : "would advance"} to Complete Uploaded`);
          continue;
        }

        // 2. Not on PB → portal search (only for labs whose scraper can probe).
        if (!scraper?.probeByName) {
          tally.searching++;
          log(`    • ${c.id.slice(0, 8)} → not on PB; ${labKey || "lab"} has no portal search yet → keep searching`);
          continue;
        }
        const cands = candsByLab.get(labKey) ?? [];
        const cand = bestCandidate(c, cands);
        if (!cand || !cand.ref) {
          tally.searching++;
          log(`    • ${c.id.slice(0, 8)} → not on PB, no live portal result → keep searching`);
          continue;
        }
        const off = daysOff(c.collection_date, cand.collectionDate);
        if (c.collection_date && off != null && off > WINDOW_DAYS) {
          tally.searching++;
          log(`    • ${c.id.slice(0, 8)} → portal only has stale acc=${cand.ref} (${Math.round(off)}d off) → keep searching`);
          continue;
        }

        if (!apply) {
          // Dry: grade on candidate signals (no pdf yet → engine adds +5 live).
          const g = gradeCapture({
            patientNameMatch: true,
            // Only claim a DOB match if the portal actually verified it; portals
            // without DOB (GlycanAge/DoctorsData) score as name-only here.
            patientDobMatch: cand.dobConfirmed ? true : null,
            hasAccessionExact: !!c.lab_external_ref && cand.ref === c.lab_external_ref,
            daysOffAnchor: off,
            portalStatusComplete: !!cand.status?.toLowerCase().includes("complete"),
            hasFinalDate: !!cand.resultIssuedAt,
          });
          const wouldAuto = g.score >= AUTOPOST_THRESHOLD;
          if (wouldAuto) tally.autoposted++; else tally.flagged++;
          log(`    • ${c.id.slice(0, 8)} → would download acc=${cand.ref} grade≈${g.score} → ${wouldAuto ? "AUTO-POST" : "FLAG"}`);
          continue;
        }

        // Apply: download the chosen accession, grade with pdf bytes, stage.
        const run = await scraper.run(browser, [toOpenCase(c, cand.ref)]);
        const found = run.found[0];
        if (!found) {
          tally.errors++;
          log(`    ✗ ${c.id.slice(0, 8)} download failed for acc=${cand.ref}: ${run.errors[0]?.message ?? "no result"}`);
          continue;
        }
        const complete = !!cand.status?.toLowerCase().includes("complete");
        const grade = gradeCapture({
          patientNameMatch: true,
          patientDobMatch: cand.dobConfirmed ? true : null,
          hasAccessionExact: !!c.lab_external_ref && found.labExternalRef === c.lab_external_ref,
          daysOffAnchor: off,
          portalStatusComplete: complete,
          hasFinalDate: !!found.resultIssuedAt,
          pdfBytes: Buffer.from(found.pdfBase64, "base64").length,
        });
        const auto = grade.score >= AUTOPOST_THRESHOLD;
        try {
          await postResultReady({
            caseId: c.id,
            labExternalRef: found.labExternalRef,
            pdfBase64: found.pdfBase64,
            pdfFilename: found.pdfFilename,
            resultIssuedAt: found.resultIssuedAt,
            source: "engine:reconcile",
            isPartial: !complete,
            autoApprove: auto,
            confidence: grade.score,
            portalPatientName: found.portalPatientName,
          });
        } catch (err) {
          tally.errors++;
          log(`    ✗ ${c.id.slice(0, 8)} stage failed: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (auto) {
          tally.autoposted++;
          log(`    ✓ ${c.id.slice(0, 8)} acc=${found.labExternalRef} grade=${grade.score} → STAGED + AUTO-APPROVED (PB upload queued)`);
        } else {
          tally.flagged++;
          log(`    ⚑ ${c.id.slice(0, 8)} acc=${found.labExternalRef} grade=${grade.score} → STAGED, FLAGGED for review (${grade.reasons.join(", ")})`);
        }
      }
      } catch (err) {
        tally.errors++;
        log(`  ✗ ${plist[0]?.patient_name ?? "?"} — patient skipped (continuing): ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await browser.close();
  }

  log("\n" + "─".repeat(84));
  log(`SUMMARY  (${apply ? "applied" : "dry-run"})`);
  log("─".repeat(84));
  log(`  advanced (already on PB):   ${tally.advanced}`);
  log(`  auto-posted (grade ≥${AUTOPOST_THRESHOLD}):    ${tally.autoposted}`);
  log(`  flagged for Nadia+Alex:     ${tally.flagged}`);
  log(`  keep-searching:             ${tally.searching}`);
  log(`  errors:                     ${tally.errors}`);
  if (!apply) log(`\nDry-run — re-run with --apply to act.`);

  // Persist metrics for the Analytics Engine tab (only real applied runs, so
  // manual dry runs don't pollute the trend). Both are best-effort (swallow).
  if (apply) {
    await postEngineRun({ lab: labArg, mode: "apply", ...tally });
    // Coverage is global; only the comprehensive --lab=all run writes a snapshot.
    if (labArg.toLowerCase() === "all") {
      await postCoverageSnapshot(
        allPbReqs.map((lr) => ({
          name: lr.name,
          dateOrdered: lr.dateOrdered ?? null,
          clientId: lr.clientRecord?.id ?? null,
          firstName: lr.clientRecord?.profile?.firstName ?? null,
          lastName: lr.clientRecord?.profile?.lastName ?? null,
        })),
      );
    }
  }
}

async function main() {
  // `--loop` (used by the Fly `reconcile` process) re-runs the sweep every
  // RECONCILE_LOOP_MS so aged/forgotten cards get caught + advanced/posted
  // without anyone touching a terminal. A crash in one cycle is logged and the
  // loop continues. Bare invocation stays one-shot (manual/dry runs).
  if (!loop) {
    await runOnce();
    return;
  }
  const intervalMs = Number(process.env.RECONCILE_LOOP_MS ?? String(3 * 60 * 60 * 1000)); // 3h
  log(`reconcile loop: every ${intervalMs}ms (lab=${labArg}, ${apply ? "APPLY" : "DRY"})`);
  await sleep(10_000); // let app + sibling processes settle after a deploy
  for (;;) {
    try {
      await runOnce();
      await reportHeartbeat("reconcile");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A persistent PB 401/403 on the cycle's FIRST calls (pbLogin + the big
      // labrequest pull, which sit OUTSIDE the per-patient try/catch) silently
      // no-ops the entire 3h sweep — and withRetry doesn't treat auth as
      // transient, so it lands here. Log it LOUDLY (not the quiet "continuing"
      // line) and report the heartbeat as error so the watchdog actually fires.
      if (isPbAuthError(err)) {
        const authMsg = `PB AUTH FAILED — whole reconcile sweep skipped (expired session / bad creds / IP block): ${msg}`;
        log(`!! ${authMsg}`);
        await reportHeartbeat("reconcile", { status: "error", error: authMsg });
      } else {
        log(`cycle error (continuing): ${msg}`);
        await reportHeartbeat("reconcile", { status: "error", error: msg });
      }
    }
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
