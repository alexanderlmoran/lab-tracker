// IV post-drain core: claim queued IV post jobs, grade the PB patient match, and
// post/update/hold the session note. Shared by the one-shot CLI
// (scripts/iv-post-worker.ts) and the scheduled loop (scripts/iv-autopost-loop.ts).
//
// PB traffic goes through pbRequest (residential/Tailscale egress on Fly; direct
// locally). Reads TRACKER_BASE_URL + WORKER_SHARED_SECRET from the env (call
// loadEnvLocal() first in the entry script).

import { request } from "undici";

import { pbLogin, searchPbPatientCandidates, createPbPatient, type PbSession } from "../uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote, createSessionNote, updateSessionNote, findSameDayNote } from "../uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, ivNoteSummary, ivNoteTitle, type IvChartInput } from "./build-note-content.js";
import { defaultIvChart, mergeIvChart } from "./default-chart.js";
import { pickBestMatch, type PatientIdentity } from "./match-patient.js";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

function env() {
  const BASE = process.env.TRACKER_BASE_URL;
  const SECRET = process.env.WORKER_SHARED_SECRET;
  if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");
  return { BASE, SECRET };
}

type Claim = {
  job: { id: string; sessionId: string };
  session: { id: string; serviceName: string; kind: string; templateHint: string | null; sessionDate: string; chart: IvChartInput; pc: { infusionNumber?: number | null; vialCount?: string }; pbNoteId?: string | null; pbClientRecordId?: string | null; createPbAccount?: boolean };
  identity: PatientIdentity;
  referenceNoteId: string | null;
  /** true = matched the service's own template; false = generic base-IV fallback
   *  (→ don't catalog-fill components, or we'd post the base cocktail). */
  templateMatched?: boolean;
};

async function claimNext(): Promise<Claim | null> {
  const { BASE, SECRET } = env();
  const res = await request(`${BASE}/api/worker/iv-post/next`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  if (res.statusCode === 204) { await res.body.text(); return null; }
  if (res.statusCode !== 200) throw new Error(`claim ${res.statusCode}: ${(await res.body.text()).slice(0, 200)}`);
  return (await res.body.json()) as Claim;
}

async function report(body: Record<string, unknown>) {
  const { BASE, SECRET } = env();
  const res = await request(`${BASE}/api/worker/iv-post/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.body.text();
  if (res.statusCode !== 200) log(`!! result rejected ${res.statusCode}: ${txt.slice(0, 150)}`);
}

/** A same-patient, same-DATE PB note whose title overlaps our intended note /
 *  template — i.e. a likely duplicate (staff already charted it by hand, or a
 *  prior untracked post). Returns the existing note's name, or null. Defensive:
 *  a list failure resolves to null so a transient read error never blocks a post.
 *  This is the guard for the "didn't recognize an existing same-day note" bug. */
async function findSameDayDuplicate(
  pb: PbSession,
  clientRecordId: string,
  sessionDate: string,
  title: string,
  templateHint: string | null,
): Promise<string | null> {
  const note = await findSameDayNote(pb, clientRecordId, sessionDate, [templateHint ?? "", title]);
  return note ? note.name ?? "(untitled)" : null;
}

async function handle(claim: Claim, pb: PbSession) {
  const { job, session: s, identity, referenceNoteId, templateMatched } = claim;
  // EBOO/EBO2 are charted by hand in PB (no standardized template) — never auto-post.
  if (s.kind === "ebo") {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "EBOO/EBO2 charted manually in PB (auto-post disabled)" });
    log(`hold (manual EBOO/EBO2) session=${s.id}`);
    return;
  }
  // Add-ons attach to the visit's BASE IV note — never a standalone note.
  if (s.kind === "addon") {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "add-on — include its components on the base IV note (no standalone note)" });
    log(`skip (add-on) session=${s.id}`);
    return;
  }
  if (!referenceNoteId) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: `no reference scaffold for template "${s.templateHint}" — add it to iv_template_refs` });
    log(`hold (no scaffold) session=${s.id}`);
    return;
  }

  // Fill a default chart (plausible age-based vitals, gauge/attempts/assessment)
  // UNDER the saved chart so a placeholder posts as a complete, editable note
  // instead of blank — staff-charted values always win (mergeIvChart).
  const chart = mergeIvChart(defaultIvChart({ kind: s.kind, serviceName: s.serviceName, dob: identity.dob }), s.chart);

  // Title/summary/date are pure (no PB call) — compute once for every branch.
  // Prefer the form-entered infusion#/vials (chart.pc) over the synced columns so
  // the "# Vials" / "Infusion #" charting fields actually reach the PC note title.
  // The number assigned by the claim endpoint (s.pc.infusionNumber, written from
  // the local ledger) is authoritative; the chart value is only a fallback. Vials
  // are per-visit, so the chart's value wins for those.
  const title = ivNoteTitle({
    serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind,
    pc: { infusionNumber: s.pc?.infusionNumber ?? chart.pc?.infusionNumber, vialCount: chart.pc?.vialCount ?? s.pc?.vialCount },
  });
  const summary = ivNoteSummary(chart); // flags incomplete charting in PB
  const sessionDate = `${s.sessionDate}T12:00:00.000Z`;

  // Un-templated IV (base-IV fallback) with NO charted components would auto-post
  // a BLANK note via the sweep's "never miss a note" path. A missing-components
  // note is worse than a held one — hold for staff to chart it first. (Matched
  // templates still post; re-posts of an existing note still update.)
  const hasComponents = (chart.components ?? []).some((c) => (c.name ?? "").trim());
  const isRepost = !!(s.pbNoteId && s.pbClientRecordId);
  if (templateMatched === false && !hasComponents && !isRepost) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "un-templated IV with no charted components — chart its components before posting (would post blank)" });
    log(`hold (un-templated, no components) session=${s.id} service="${s.serviceName}"`);
    return;
  }

  // PC infusions are numbered from our LOCAL ledger (assigned at claim time in
  // /api/worker/iv-post/next). A null number here means the patient hasn't been
  // seeded from PB yet (or is an ambiguous match we won't auto-number) → HOLD
  // rather than post an unnumbered "Phosphatidylcholine Infusion" (the title-
  // mismatch bug). Applies to the staff-confirmed path too — vouching for the
  // patient match doesn't license posting unnumbered; staff set the # on the chart
  // form (it then becomes authoritative). Only re-posts skip (title already set).
  const pcNumber = s.pc?.infusionNumber ?? chart.pc?.infusionNumber;
  if (s.kind === "pc" && pcNumber == null && !isRepost) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "PC infusion # not set — auto-assigns once the patient's series is bootstrapped from PB, or enter it on the chart form" });
    log(`hold (PC not numbered yet) session=${s.id}`);
    return;
  }

  // Build the note body from the reference scaffold, or HOLD if it's empty.
  // An empty scaffold (reference note missing/blank in PB) would otherwise post
  // a title-only note with no charting — and once it has a pb_note_id the sweep
  // (which only enqueues pb_note_id IS NULL) stops retrying it, so it never
  // self-corrects. Holding keeps it in review and re-enqueuing until the ref is
  // re-captured. Built lazily so a low-confidence hold doesn't fetch the ref.
  const buildContentOrHold = async () => {
    const ref = await getSessionNote(pb, referenceNoteId);
    // Only an EXPLICIT false (new endpoint, base-IV fallback) suppresses the
    // catalog fill. undefined (old endpoint, mid-deploy) keeps prior behavior.
    const content = buildIvNoteContent(scaffoldFromNote(ref), chart, { baseFallback: templateMatched === false });
    if (content.length === 0) {
      await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: `reference scaffold for "${s.templateHint}" is empty — re-capture its reference note (iv_template_refs)` });
      log(`hold (empty scaffold) session=${s.id} template="${s.templateHint}"`);
      return null;
    }
    return content;
  };

  // Re-post of an already-posted session → UPDATE the same note (never a
  // duplicate), reusing the patient matched on the first post.
  if (s.pbNoteId && s.pbClientRecordId) {
    const content = await buildContentOrHold();
    if (!content) return;
    await updateSessionNote(pb, s.pbNoteId, { clientRecordId: s.pbClientRecordId, name: title, summary, sessionDate, content });
    await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: s.pbNoteId, pbClientRecordId: s.pbClientRecordId, score: null, reason: "updated existing note (re-post)" });
    log(`UPDATED note=${s.pbNoteId} session=${s.id}`);
    return;
  }

  // Staff-confirmed match (resolved a hold): pb_client_record_id set, no note yet
  // → post to that record, skipping the auto-match gate (a human vouched for it).
  if (!s.pbNoteId && s.pbClientRecordId) {
    const content = await buildContentOrHold();
    if (!content) return;
    const created = await createSessionNote(pb, { clientRecordId: s.pbClientRecordId, name: title, summary, sessionDate, content });
    await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: created.id, pbClientRecordId: s.pbClientRecordId, score: null, reason: "posted to staff-confirmed patient" });
    log(`POSTED (confirmed) note=${created.id} session=${s.id}`);
    return;
  }

  const query = (identity.fullName || identity.email || "").trim();
  const candidates = await searchPbPatientCandidates(pb, query);
  const best = pickBestMatch(identity, candidates);
  if (!best) {
    // No PB account exists for this patient. If staff explicitly clicked "Create
    // PB account & post", create the record now (createPbPatient sends PB's invite
    // email) and post to it. We only do this when the matcher found NOBODY, so a
    // bad search can't spawn a duplicate of an existing patient — that's the whole
    // safety property. Without the staff flag, hold as before. Build the note body
    // FIRST so an empty scaffold holds without leaving an orphan account behind.
    if (s.createPbAccount) {
      const first = (identity.firstName || identity.fullName?.split(/\s+/)[0] || "").trim();
      const last = (identity.lastName || identity.fullName?.split(/\s+/).slice(1).join(" ") || "").trim();
      const email = (identity.email || "").trim();
      if (!first || !last || !email) {
        await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "can't create PB account — need first name, last name, and email (add the patient's email in Zenoti, then re-try)" });
        log(`hold (create-account: missing first/last/email) session=${s.id}`);
        return;
      }
      const content = await buildContentOrHold();
      if (!content) return;
      const newPatient = await createPbPatient(pb, { firstName: first, lastName: last, email, dob: identity.dob });
      const created = await createSessionNote(pb, { clientRecordId: newPatient.id, name: title, summary, sessionDate, content });
      await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: created.id, pbClientRecordId: newPatient.id, score: null, reason: `created PB account + posted (${email})` });
      log(`CREATED PB account=${newPatient.id} + POSTED note=${created.id} session=${s.id}`);
      return;
    }
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "no PB candidates for query" });
    log(`hold (no candidates) session=${s.id}`);
    return;
  }
  if (!best.autoPostable) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: best.score, reason: best.reason, pbClientRecordId: best.candidate.id });
    log(`hold (low confidence) session=${s.id}: ${best.reason}`);
    return;
  }

  // Duplicate guard: never auto-create a 2nd note when this patient already has a
  // matching note for this date (staff hand-charted it, or a prior untracked post).
  const dupeName = await findSameDayDuplicate(pb, best.candidate.id, s.sessionDate, title, s.templateHint);
  if (dupeName) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: best.score, reason: `existing note for ${s.sessionDate} ("${dupeName}") — verify before creating a duplicate`, pbClientRecordId: best.candidate.id });
    log(`hold (possible duplicate) session=${s.id}: existing "${dupeName}"`);
    return;
  }

  const content = await buildContentOrHold();
  if (!content) return;
  const created = await createSessionNote(pb, { clientRecordId: best.candidate.id, name: title, summary, sessionDate, content });
  await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: created.id, pbClientRecordId: best.candidate.id, score: best.score, reason: best.reason });
  log(`POSTED note=${created.id} score=${best.score} session=${s.id}`);
}

/** Drain up to `max` queued IV post jobs with an established PB session.
 *  Returns the count processed and whether a PB AUTH error (401) was seen — the
 *  caller should then re-login (the PB session expires after a few hours, and a
 *  swallowed 401 would otherwise wedge the loop forever). Jobs that failed on a
 *  401 are left as 'failed' and self-heal: the next sweep re-enqueues them. */
export async function drainIvPosts(pb: PbSession, max = 50): Promise<{ processed: number; authError: boolean }> {
  let processed = 0;
  let authError = false;
  while (processed < max) {
    const claim = await claimNext();
    if (!claim) break;
    try {
      await handle(claim, pb);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b401\b|unauthor/i.test(msg)) authError = true;
      await report({ jobId: claim.job.id, sessionId: claim.session.id, outcome: "failed", error: msg });
      log(`!! failed session=${claim.session.id}: ${msg}`);
    }
    processed++;
  }
  return { processed, authError };
}
