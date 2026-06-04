// Reconciliation DRY-RUN — shows, per stuck case, exactly what the closed-loop
// engine WOULD do, with ZERO writes (no PB posts, no step5 advances):
//
//   1. On PB already?  → would advance card to Complete Uploaded (classifyCase).
//   2. Not on PB → search the portal by name → grade the capture →
//        ≥90  → would AUTO-POST to PB + advance
//        <90  → would stay Pending Upload, FLAG for Nadia + Alex
//   3. No PB, no portal hit → needs-review.
//
// Lets Alex eyeball the confidence scores + routing BEFORE anything posts itself.
//   cd worker
//   npx tsx scripts/reconcile-dry.ts                          # Fereshteh, Access
//   npx tsx scripts/reconcile-dry.ts --patient=all --lab=Access
//
// Portal search currently exists for Access only; other labs report
// "portal-search-not-built" until the template is rolled out (task #6).

import { request } from "undici";
import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const {
  pbLogin,
  findPbPatient,
  listAllConsultantLabRequests,
} = await import("../src/uploaders/practicebetter.js");
const { classifyCase } = await import("../src/backfill/engine.js");
const { gradeCapture, AUTO_POST_THRESHOLD } = await import("../src/recon/grade.js");
const { accessScraper } = await import("../src/scrapers/access.js");

type BackfillCaseT = import("../src/backfill/engine.js").BackfillCase;
type ProbeCandidateT = import("../src/scrapers/base.js").ProbeCandidate;

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET required");
if (!PB_USERNAME || !PB_PASSWORD) throw new Error("PB_USERNAME / PB_PASSWORD required");

const argv = process.argv.slice(2);
const patientArg = argv.find((a) => a.startsWith("--patient="))?.split("=")[1] ?? "Fereshteh Krasowski";
const labArg = argv.find((a) => a.startsWith("--lab="))?.split("=")[1] ?? "Access";
const log = (m = "") => console.log(m);

type TrackerCase = {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  lab_name: string;
  collection_date: string | null;
  lab_external_ref: string | null;
  tracking_number: string | null;
  zenoti_appointment_id: string | null;
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
  const url = `${TRACKER_BASE}/api/worker/debug/cases?${q}deleted=null`;
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

/** Pick the candidate best matching a case: ready ones first, closest collection
 *  date to the case's draw date (fallback: the newest, which probeByName lists
 *  first). */
function bestCandidate(c: TrackerCase, cands: ProbeCandidateT[]): ProbeCandidateT | null {
  if (cands.length === 0) return null;
  const ready = cands.filter((x) => x.status?.toLowerCase().includes("complete"));
  const pool = ready.length ? ready : cands;
  if (c.collection_date) {
    return pool
      .map((x) => ({ x, off: daysOff(c.collection_date, x.collectionDate) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.off - b.off)[0].x;
  }
  return pool[0];
}

async function main() {
  log("─".repeat(82));
  log(`RECONCILE DRY-RUN — lab=${labArg} patient=${patientArg}  (NO WRITES)`);
  log("─".repeat(82));

  const session = await pbLogin(PB_USERNAME!, PB_PASSWORD!);
  const cases = await fetchCases(patientArg, labArg);
  log(`Stuck ${labArg} cases (step1=true, step5=false): ${cases.length}\n`);
  if (cases.length === 0) return;

  const hasPortalSearch = !!accessScraper.probeByName && labArg.toLowerCase() === "access";
  const browser = hasPortalSearch ? await chromium.launch({ headless: true }) : null;

  // Group by patient → one PB list + one portal search per patient.
  const byPatient = new Map<string, TrackerCase[]>();
  for (const c of cases) {
    const k = c.patient_name.trim().toLowerCase();
    byPatient.set(k, [...(byPatient.get(k) ?? []), c]);
  }

  const tally = { advance: 0, autopost: 0, flag: 0, noportal: 0, review: 0, nopatient: 0 };

  try {
    for (const [pname, plist] of byPatient) {
      const first = plist[0];
      const pbPatient = await findPbPatient(session, first.patient_name, first.patient_dob ?? undefined);
      const pbReqs = pbPatient
        ? (await listAllConsultantLabRequests(session, { limit: 2000 })).filter(
            (lr) => lr.clientRecord?.id === pbPatient.id,
          )
        : [];
      log(`▸ ${first.patient_name}  pb=${pbPatient ? pbReqs.length + " labrequests" : "NO PB RECORD"}`);

      // One portal search for the whole patient (probeByName lists, no download).
      let cands: ProbeCandidateT[] = [];
      if (hasPortalSearch && browser) {
        try {
          cands = await accessScraper.probeByName!(browser, first.patient_name, first.patient_dob);
        } catch (err) {
          log(`    portal search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for (const c of plist) {
        const decision = classifyCase(toBackfillCase(c), pbReqs);
        // 1. Already on PB → would advance.
        if (decision.action === "already-on-pb") {
          tally.advance++;
          log(`    • ${c.id.slice(0, 8)} collected=${c.collection_date ?? "—"}  → ON PB (${decision.confidence}) → would ADVANCE to Complete Uploaded`);
          continue;
        }
        // 2. Not on PB → portal search + grade.
        if (!hasPortalSearch) {
          tally.noportal++;
          log(`    • ${c.id.slice(0, 8)} collected=${c.collection_date ?? "—"}  → not on PB; portal-search-not-built for ${c.lab_name}`);
          continue;
        }
        const cand = bestCandidate(c, cands);
        if (!cand) {
          tally.review++;
          log(`    • ${c.id.slice(0, 8)} collected=${c.collection_date ?? "—"}  → not on PB, no portal result → needs-review`);
          continue;
        }
        const off = daysOff(c.collection_date, cand.collectionDate);
        const grade = gradeCapture({
          patientNameMatch: true, // probeByName already name-filtered
          patientDobMatch: c.patient_dob ? true : null, // and dob-filtered when known
          hasAccessionExact: !!c.lab_external_ref && cand.ref === c.lab_external_ref,
          daysOffAnchor: off,
          portalStatusComplete: !!cand.status?.toLowerCase().includes("complete"),
          hasFinalDate: !!cand.resultIssuedAt,
          // pdfBytes omitted — dry-run doesn't download; the live engine adds +5.
        });
        if (grade.decision === "auto-post") tally.autopost++;
        else tally.flag++;
        const tag = grade.decision === "auto-post" ? "AUTO-POST" : "FLAG (Pending Upload)";
        log(
          `    • ${c.id.slice(0, 8)} collected=${c.collection_date ?? "—"}  → not on PB; portal acc=${cand.ref} ` +
            `coll=${cand.collectionDate} ${cand.status}  grade=${grade.score} → ${tag}`,
        );
        log(`        ${grade.reasons.join(", ")}`);
      }
      if (!pbPatient) tally.nopatient += plist.length;
    }
  } finally {
    if (browser) await browser.close();
  }

  log("\n" + "─".repeat(82));
  log("WOULD-DO SUMMARY (dry-run, nothing written)");
  log("─".repeat(82));
  log(`  advance (already on PB):        ${tally.advance}`);
  log(`  auto-post (grade ≥${AUTO_POST_THRESHOLD}):           ${tally.autopost}`);
  log(`  flag for Nadia+Alex (<${AUTO_POST_THRESHOLD}):       ${tally.flag}`);
  log(`  needs-review (no portal hit):   ${tally.review}`);
  log(`  portal-search-not-built:        ${tally.noportal}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
