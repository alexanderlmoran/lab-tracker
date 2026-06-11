// IV note post worker. Claims charted IV sessions, grades the PB patient match
// (name+DOB+email → 0-100), and AUTO-POSTS the session note when score >= 95
// with a clear lead; otherwise reports 'held' for human review. PB traffic goes
// through pbRequest (residential/Tailscale egress on Fly; direct locally).
//
// Run:  cd worker && npx tsx scripts/iv-post-worker.ts
// (one drain pass; wrap in a Fly [processes] loop for prod — see PLAYBOOK)

import { request } from "undici";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, searchPbPatientCandidates, type PbSession } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote, createSessionNote } from "../src/uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, ivNoteTitle, type IvChartInput } from "../src/iv/build-note-content.js";
import { pickBestMatch, type PatientIdentity } from "../src/iv/match-patient.js";

loadEnvLocal();
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const PB_USER = process.env.PB_USERNAME;
const PB_PASS = process.env.PB_PASSWORD;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");
if (!PB_USER || !PB_PASS) throw new Error("PB_USERNAME + PB_PASSWORD required");

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

type Claim = {
  job: { id: string; sessionId: string };
  session: { id: string; serviceName: string; kind: string; templateHint: string | null; sessionDate: string; chart: IvChartInput; pc: { infusionNumber?: number | null; vialCount?: string } };
  identity: PatientIdentity;
  referenceNoteId: string | null;
};

async function claimNext(): Promise<Claim | null> {
  const res = await request(`${BASE}/api/worker/iv-post/next`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  if (res.statusCode === 204) { await res.body.text(); return null; }
  if (res.statusCode !== 200) throw new Error(`claim ${res.statusCode}: ${(await res.body.text()).slice(0, 200)}`);
  return (await res.body.json()) as Claim;
}

async function report(body: Record<string, unknown>) {
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
  if (!referenceNoteId) {
    await report({ jobId: job.id, sessionId: s.id, outcome: "held", score: null, reason: `no reference scaffold for template "${s.templateHint}" — add it to iv_template_refs` });
    log(`hold (no scaffold) session=${s.id}`);
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
  const scaffold = scaffoldFromNote(ref);
  const content = buildIvNoteContent(scaffold, s.chart);
  const title = ivNoteTitle({ serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind, pc: s.pc });
  const created = await createSessionNote(pb, {
    clientRecordId: best.candidate.id,
    name: title,
    sessionDate: `${s.sessionDate}T12:00:00.000Z`,
    content,
  });
  await report({ jobId: job.id, sessionId: s.id, outcome: "success", pbNoteId: created.id, pbClientRecordId: best.candidate.id, score: best.score, reason: best.reason });
  log(`POSTED note=${created.id} score=${best.score} session=${s.id}`);
}

async function main() {
  const pb = await pbLogin(PB_USER!, PB_PASS!);
  log("PB session established");
  let processed = 0;
  while (processed < 50) {
    const claim = await claimNext();
    if (!claim) break;
    try {
      await handle(claim, pb);
    } catch (e) {
      await report({ jobId: claim.job.id, sessionId: claim.session.id, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
      log(`!! failed session=${claim.session.id}: ${e instanceof Error ? e.message : e}`);
    }
    processed++;
  }
  log(`done; processed ${processed} job(s)`);
}
main().catch((e) => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
