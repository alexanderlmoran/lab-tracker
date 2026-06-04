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
//   npx tsx scripts/reconcile.ts                       # Fereshteh, dry
//   npx tsx scripts/reconcile.ts --patient=all --apply # whole Access set, live
//
// Access only today; rolls to other portals once they expose probeByName.

import { request } from "undici";
import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const { pbLogin, findPbPatient, listAllConsultantLabRequests } = await import(
  "../src/uploaders/practicebetter.js"
);
const { classifyCase } = await import("../src/backfill/engine.js");
const { gradeCapture } = await import("../src/recon/grade.js");
const { accessScraper } = await import("../src/scrapers/access.js");
const { postResultReady } = await import("../src/tracker-client.js");

type BackfillCaseT = import("../src/backfill/engine.js").BackfillCase;
type ProbeCandidateT = import("../src/scrapers/base.js").ProbeCandidate;
type OpenCaseT = import("../src/tracker-client.js").OpenCase;

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
const log = (m = "") => console.log(m);

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
  return (json.cases ?? []).filter(
    (c) =>
      c.step1_sample_sent &&
      !c.step5_complete_uploaded &&
      !c.archived_at &&
      c.lab_name?.toLowerCase() === lab.toLowerCase(),
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

async function main() {
  log("─".repeat(84));
  log(`RECONCILE ENGINE — lab=${labArg} patient=${patientArg}  ${apply ? "APPLY (LIVE)" : "DRY (no writes)"}`);
  log("─".repeat(84));

  const session = await pbLogin(PB_USERNAME!, PB_PASSWORD!);
  const cases = await fetchCases(patientArg, labArg);
  log(`Stuck ${labArg} cases: ${cases.length}\n`);
  if (cases.length === 0) return;

  const browser = await chromium.launch({ headless: true });
  const byPatient = new Map<string, TrackerCase[]>();
  for (const c of cases) {
    const k = c.patient_name.trim().toLowerCase();
    byPatient.set(k, [...(byPatient.get(k) ?? []), c]);
  }

  const tally = { advanced: 0, autoposted: 0, flagged: 0, searching: 0, errors: 0 };

  try {
    for (const [, plist] of byPatient) {
      const first = plist[0];
      const pbPatient = await findPbPatient(session, first.patient_name, first.patient_dob ?? undefined);
      const pbReqs = pbPatient
        ? (await listAllConsultantLabRequests(session, { limit: 2000 })).filter(
            (lr) => lr.clientRecord?.id === pbPatient.id,
          )
        : [];
      let cands: ProbeCandidateT[] = [];
      try {
        cands = await accessScraper.probeByName!(browser, first.patient_name, first.patient_dob);
      } catch (err) {
        log(`  ⚠ ${first.patient_name}: portal search failed: ${err instanceof Error ? err.message : err}`);
      }
      log(`▸ ${first.patient_name}  pb=${pbReqs.length}  portal=${cands.length}`);

      for (const c of plist) {
        // 1. Already on PB → advance.
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

        // 2. Not on PB → portal.
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
            patientDobMatch: c.patient_dob ? true : null,
            hasAccessionExact: !!c.lab_external_ref && cand.ref === c.lab_external_ref,
            daysOffAnchor: off,
            portalStatusComplete: !!cand.status?.toLowerCase().includes("complete"),
            hasFinalDate: !!cand.resultIssuedAt,
          });
          if (g.decision === "auto-post") tally.autoposted++; else tally.flagged++;
          log(`    • ${c.id.slice(0, 8)} → would download acc=${cand.ref} grade≈${g.score} → ${g.decision === "auto-post" ? "AUTO-POST" : "FLAG"}`);
          continue;
        }

        // Apply: download the chosen accession, grade with pdf bytes, stage.
        const run = await accessScraper.run(browser, [toOpenCase(c, cand.ref)]);
        const found = run.found[0];
        if (!found) {
          tally.errors++;
          log(`    ✗ ${c.id.slice(0, 8)} download failed for acc=${cand.ref}: ${run.errors[0]?.message ?? "no result"}`);
          continue;
        }
        const complete = !!cand.status?.toLowerCase().includes("complete");
        const grade = gradeCapture({
          patientNameMatch: true,
          patientDobMatch: c.patient_dob ? true : null,
          hasAccessionExact: !!c.lab_external_ref && found.labExternalRef === c.lab_external_ref,
          daysOffAnchor: off,
          portalStatusComplete: complete,
          hasFinalDate: !!found.resultIssuedAt,
          pdfBytes: Buffer.from(found.pdfBase64, "base64").length,
        });
        try {
          await postResultReady({
            caseId: c.id,
            labExternalRef: found.labExternalRef,
            pdfBase64: found.pdfBase64,
            pdfFilename: found.pdfFilename,
            resultIssuedAt: found.resultIssuedAt,
            source: "engine:reconcile",
            isPartial: !complete,
            autoApprove: grade.decision === "auto-post",
            confidence: grade.score,
          });
        } catch (err) {
          tally.errors++;
          log(`    ✗ ${c.id.slice(0, 8)} stage failed: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (grade.decision === "auto-post") {
          tally.autoposted++;
          log(`    ✓ ${c.id.slice(0, 8)} acc=${found.labExternalRef} grade=${grade.score} → STAGED + AUTO-APPROVED (PB upload queued)`);
        } else {
          tally.flagged++;
          log(`    ⚑ ${c.id.slice(0, 8)} acc=${found.labExternalRef} grade=${grade.score} → STAGED, FLAGGED for review (${grade.reasons.join(", ")})`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  log("\n" + "─".repeat(84));
  log(`SUMMARY  (${apply ? "applied" : "dry-run"})`);
  log("─".repeat(84));
  log(`  advanced (already on PB):   ${tally.advanced}`);
  log(`  auto-posted (grade ≥90):    ${tally.autoposted}`);
  log(`  flagged for Nadia+Alex:     ${tally.flagged}`);
  log(`  keep-searching:             ${tally.searching}`);
  log(`  errors:                     ${tally.errors}`);
  if (!apply) log(`\nDry-run — re-run with --apply to act.`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
