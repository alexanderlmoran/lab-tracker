// PB → tracker RECONCILE. The tracker is middleware and must stay IN SYNC with
// PracticeBetter: if a session was charted in PB (by hand, e.g. EBOO/EBO2, or any
// note we didn't post), the board must reflect it — not keep showing "Not charted".
//
// For each OPEN session (pending/ready, no pb_note_id, not skipped), confidently
// match the patient, look for a same-DATE PB note that matches the session, and if
// found CAPTURE it (stamp pb_note_id → the board shows it as charted, and the sweep
// stops trying to (re-)post it). Errs SAFE: no confident patient match, or no
// matching note, → leave the session on the board (manual capture still available).
//
// This is the general fix for "I charted it in PB and the tracker didn't update";
// EBOO/EBO2 (which the tracker can't post) ride the SAME sync instead of being a
// dead-end manual-only special case.
//
// PB traffic goes through pbRequest (residential/Tailscale egress on Fly). Reads
// TRACKER_BASE_URL + WORKER_SHARED_SECRET from the env (loadEnvLocal() first).

import { request } from "undici";

import { searchPbPatientCandidates, type PbSession } from "../uploaders/practicebetter.js";
import { findSameDayNote } from "../uploaders/pb-sessionnotes.js";
import { ivNoteTitle } from "./build-note-content.js";
import { pickBestMatch, type PatientIdentity } from "./match-patient.js";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

function env() {
  const BASE = process.env.TRACKER_BASE_URL;
  const SECRET = process.env.WORKER_SHARED_SECRET;
  if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");
  return { BASE, SECRET };
}

type OpenSession = {
  sessionId: string;
  serviceName: string;
  sessionDate: string;
  kind: string;
  templateHint: string | null;
  pbClientRecordId: string | null;
  identity: PatientIdentity;
  pc: { infusionNumber?: number | null; vialCount?: string };
};

// EBOO/EBO2 notes are charted by hand, so their PB title varies — match on the
// modality keywords too (in addition to the service name / computed title).
const EBO_TITLE_KEYS = ["eboo", "ebo2", "ozone", "oxygenation"];

async function fetchOpen(days: number, max: number): Promise<OpenSession[]> {
  const { BASE, SECRET } = env();
  const res = await request(`${BASE}/api/worker/iv-reconcile/open?days=${days}&max=${max}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.statusCode !== 200) { await res.body.text(); return []; }
  const { sessions } = (await res.body.json()) as { sessions: OpenSession[] };
  return sessions ?? [];
}

async function capture(sessionId: string, pbNoteId: string, pbClientRecordId: string): Promise<boolean> {
  const { BASE, SECRET } = env();
  const res = await request(`${BASE}/api/worker/iv-reconcile/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, pbNoteId, pbClientRecordId }),
  });
  const txt = await res.body.text();
  if (res.statusCode !== 200) { log(`!! capture rejected ${res.statusCode}: ${txt.slice(0, 150)}`); return false; }
  return true;
}

/** Reconcile open sessions against PB. Returns counts (checked/captured). Caller
 *  wraps this in withTimeout so a slow PB read can never hang the loop. */
export async function reconcileChartedNotes(pb: PbSession, opts: { days?: number; max?: number } = {}): Promise<{ checked: number; captured: number }> {
  const days = opts.days ?? 7;
  const max = opts.max ?? 60;
  const open = await fetchOpen(days, max);
  let captured = 0;

  for (const s of open) {
    try {
      // Resolve the PB client record: a record already vouched/posted for this
      // session wins; otherwise require a CONFIDENT match (same bar as auto-post)
      // so we never attribute a PB note to the wrong person.
      let clientRecordId = s.pbClientRecordId;
      if (!clientRecordId) {
        const query = (s.identity.fullName || s.identity.email || "").trim();
        if (!query) continue;
        const best = pickBestMatch(s.identity, await searchPbPatientCandidates(pb, query));
        if (!best || !best.autoPostable) continue; // can't safely attribute → leave it
        clientRecordId = best.candidate.id;
      }

      const title = ivNoteTitle({ serviceName: s.serviceName, templateHint: s.templateHint, kind: s.kind, pc: s.pc });
      const keys = [s.templateHint ?? "", title, ...(s.kind === "ebo" ? EBO_TITLE_KEYS : [])];
      const note = await findSameDayNote(pb, clientRecordId, s.sessionDate, keys);
      if (!note) continue; // not charted in PB (yet) → stays on the board

      if (await capture(s.sessionId, note.id, clientRecordId)) {
        captured++;
        log(`reconciled session=${s.sessionId} (${s.kind}) ← PB note=${note.id} "${note.name ?? "(untitled)"}"`);
      }
    } catch (e) {
      log(`!! reconcile session=${s.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: open.length, captured };
}
