// IV post-drain core: claim queued IV post jobs, grade the PB patient match, and
// post/update/hold the session note. Shared by the one-shot CLI
// (scripts/iv-post-worker.ts) and the scheduled loop (scripts/iv-autopost-loop.ts).
//
// PB traffic goes through pbRequest (residential/Tailscale egress on Fly; direct
// locally). Reads TRACKER_BASE_URL + WORKER_SHARED_SECRET from the env (call
// loadEnvLocal() first in the entry script).

import { request } from "undici";

import { pbLogin, searchPbPatientCandidates, type PbSession } from "../uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote, createSessionNote, updateSessionNote } from "../uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, ivNoteSummary, ivNoteTitle, type IvChartInput } from "./build-note-content.js";
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
  session: { id: string; serviceName: string; kind: string; templateHint: string | null; sessionDate: string; chart: IvChartInput; pc: { infusionNumber?: number | null; vialCount?: string }; pbNoteId?: string | null; pbClientRecordId?: string | null };
  identity: PatientIdentity;
  referenceNoteId: string | null;
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

async function handle(claim: Claim, pb: PbSession) {
  const { job, session: s, identity, referenceNoteId } = claim;
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

  // Re-post of an already-posted session → UPDATE the same note (never a
  // duplicate), reusing the patient matched on the first post.
  if (s.pbNoteId && s.pbClientRecordId) {
    const ref = await getSessionNote(pb, referenceNoteId);
    const content = buildIvNoteContent(scaffoldFromNote(ref), s.chart);
    const title = ivNoteTitle({ serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind, pc: s.pc });
    await updateSessionNote(pb, s.pbNoteId, {
      clientRecordId: s.pbClientRecordId, name: title, summary: ivNoteSummary(s.chart),
      sessionDate: `${s.sessionDate}T12:00:00.000Z`, content,
    });
    await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: s.pbNoteId, pbClientRecordId: s.pbClientRecordId, score: null, reason: "updated existing note (re-post)" });
    log(`UPDATED note=${s.pbNoteId} session=${s.id}`);
    return;
  }

  // Staff-confirmed match (resolved a hold): pb_client_record_id set, no note yet
  // → post to that record, skipping the auto-match gate (a human vouched for it).
  if (!s.pbNoteId && s.pbClientRecordId) {
    const ref = await getSessionNote(pb, referenceNoteId);
    const content = buildIvNoteContent(scaffoldFromNote(ref), s.chart);
    const title = ivNoteTitle({ serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind, pc: s.pc });
    const created = await createSessionNote(pb, {
      clientRecordId: s.pbClientRecordId, name: title, summary: ivNoteSummary(s.chart),
      sessionDate: `${s.sessionDate}T12:00:00.000Z`, content,
    });
    await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: created.id, pbClientRecordId: s.pbClientRecordId, score: null, reason: "posted to staff-confirmed patient" });
    log(`POSTED (confirmed) note=${created.id} session=${s.id}`);
    return;
  }

  const query = (identity.fullName || identity.email || "").trim();
  const candidates = await searchPbPatientCandidates(pb, query);
  const best = pickBestMatch(identity, candidates);
  if (!best) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: "no PB candidates for query" });
    log(`hold (no candidates) session=${s.id}`);
    return;
  }
  if (!best.autoPostable) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: best.score, reason: best.reason, pbClientRecordId: best.candidate.id });
    log(`hold (low confidence) session=${s.id}: ${best.reason}`);
    return;
  }

  const ref = await getSessionNote(pb, referenceNoteId);
  const content = buildIvNoteContent(scaffoldFromNote(ref), s.chart);
  const title = ivNoteTitle({ serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind, pc: s.pc });
  const created = await createSessionNote(pb, {
    clientRecordId: best.candidate.id, name: title,
    summary: ivNoteSummary(s.chart), // flags incomplete charting in PB
    sessionDate: `${s.sessionDate}T12:00:00.000Z`, content,
  });
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
