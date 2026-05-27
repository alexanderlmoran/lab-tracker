// Backfill Brain — pure classification logic.
//
// Given a tracker case stuck at Sample Sent and the patient's PB
// labrequest list, decide which of four buckets it belongs in:
//
//   already-on-pb    — PB has a labrequest matching name + date.
//                      Action: silently advance to step5 (no emails).
//   scrape-needed    — PB doesn't have it; portal probably does.
//                      Action: queue scraper for this case (existing
//                      pipeline — human approves the upload).
//   needs-review     — Old enough to expect results, but neither PB
//                      nor any clear portal path. Human must look.
//   leave            — Recent (within grace window). Still legitimately
//                      pending; do nothing.
//
// No I/O here — caller provides the data, engine returns a plan. The
// CLI / endpoint that drives the engine handles fetching + executing.

import type { PbLabRequest } from "../uploaders/practicebetter.js";

export type BackfillCase = {
  caseId: string;
  patientName: string;
  patientDob: string | null;
  labName: string;
  /** ISO date string (YYYY-MM-DD) — sample collection date if known, else null. */
  collectionDate: string | null;
  /** ISO timestamp of case creation — used as a fallback when collectionDate is null. */
  createdAt: string;
  /** Lab order/accession number, if staff entered it. */
  labExternalRef: string | null;
  /** All steps from the tracker — used to skip already-complete cases. */
  step1: boolean;
  step2: boolean;
  step3: boolean;
  step4: boolean;
  step5: boolean;
};

export type BackfillAction =
  | "already-on-pb"
  | "scrape-needed"
  | "needs-review"
  | "leave";

export type BackfillDecision = {
  caseId: string;
  action: BackfillAction;
  reason: string;
  /** When action="already-on-pb", the matching PB labrequest. */
  pbLabRequest?: PbLabRequest;
  /** Confidence score for the decision: low / medium / high.
   *  Auto-execution should only happen on high. */
  confidence: "low" | "medium" | "high";
};

// How long after collection_date (or createdAt fallback) we still consider
// the case "legitimately pending" and skip backfill. Most labs return
// results in 14-21 days; we wait 30 to be safe.
const GRACE_DAYS = 30;

/** Days between two YYYY-MM-DD strings (or YYYY-MM-DDTxx ISO). Absolute value. */
function daysBetween(a: string, b: string): number {
  const da = new Date(a.slice(0, 10) + "T00:00:00Z").getTime();
  const db = new Date(b.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.abs(da - db) / 86400000;
}

function normalizeLabName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Does the PB labrequest name reference the same lab destination as
 *  the tracker case's lab_name? Substring match on normalized strings —
 *  PB names are like "Access — Acc# 007143558" or "Access Custom",
 *  tracker lab_names are like "Access". */
function labNameMatches(caseLab: string, pbName: string): boolean {
  const a = normalizeLabName(caseLab);
  const b = normalizeLabName(pbName);
  if (!a || !b) return false;
  return b.includes(a) || a.includes(b);
}

/** Find the best PB labrequest for a tracker case. Match logic:
 *   1. Same lab (substring match on normalized name).
 *   2. Date proximity: PB orderdate within ±45 days of tracker
 *      collection_date (fallback: createdAt). Closer = better.
 *   3. If accession # is on both, exact match overrides everything.
 *  Returns the best candidate + confidence, or null if nothing plausible. */
export function matchCaseToPbLabRequest(
  c: BackfillCase,
  candidates: PbLabRequest[],
): { match: PbLabRequest; confidence: "low" | "medium" | "high" } | null {
  if (candidates.length === 0) return null;
  const anchorIso = c.collectionDate ?? c.createdAt;
  const anchor = anchorIso.slice(0, 10);

  let best: { lr: PbLabRequest; daysOff: number; nameHit: boolean; accHit: boolean } | null = null;
  for (const lr of candidates) {
    const nameHit = labNameMatches(c.labName, lr.name);
    // Cheap accession check — if either side embeds the number in name.
    const accHit =
      Boolean(c.labExternalRef) &&
      lr.name.includes(c.labExternalRef!);
    if (!nameHit && !accHit) continue;

    let daysOff = Number.POSITIVE_INFINITY;
    if (lr.dateOrdered) {
      daysOff = daysBetween(anchor, lr.dateOrdered);
    }
    if (daysOff > 45 && !accHit) continue;

    if (!best || daysOff < best.daysOff || (accHit && !best.accHit)) {
      best = { lr, daysOff, nameHit, accHit };
    }
  }

  if (!best) return null;

  // Confidence ladder
  let confidence: "low" | "medium" | "high" = "low";
  if (best.accHit) confidence = "high";
  else if (best.nameHit && best.daysOff <= 7) confidence = "high";
  else if (best.nameHit && best.daysOff <= 21) confidence = "medium";
  // else stays "low"

  return { match: best.lr, confidence };
}

/** Top-level classifier. */
export function classifyCase(
  c: BackfillCase,
  pbCandidates: PbLabRequest[],
  now: Date = new Date(),
): BackfillDecision {
  // Skip already-complete cases entirely — backfill shouldn't touch them.
  if (c.step5) {
    return {
      caseId: c.caseId,
      action: "leave",
      reason: "Already at step5 (complete uploaded) — nothing to do.",
      confidence: "high",
    };
  }

  // Skip cases newer than the grace window — they might still be in
  // legitimate flight (sample mailed yesterday).
  const anchorIso = c.collectionDate ?? c.createdAt;
  const ageDays = daysBetween(anchorIso, now.toISOString());
  if (ageDays < GRACE_DAYS) {
    return {
      caseId: c.caseId,
      action: "leave",
      reason: `Only ${ageDays.toFixed(0)} days old (<${GRACE_DAYS}d grace) — legitimately pending.`,
      confidence: "high",
    };
  }

  const m = matchCaseToPbLabRequest(c, pbCandidates);
  if (m) {
    return {
      caseId: c.caseId,
      action: "already-on-pb",
      reason: `Matched PB labrequest ${m.match.id} ("${m.match.name}" on ${m.match.dateOrdered?.slice(0, 10)}); confidence=${m.confidence}.`,
      pbLabRequest: m.match,
      confidence: m.confidence,
    };
  }

  // No PB match. If we have an accession, the lab portal almost certainly
  // has the PDF (staff typed it because the result was already in hand).
  // Without one, the portal won't be queryable cleanly.
  if (c.labExternalRef) {
    return {
      caseId: c.caseId,
      action: "scrape-needed",
      reason: `No PB labrequest matches; accession ${c.labExternalRef} present — scraper can find the PDF.`,
      confidence: "medium",
    };
  }

  return {
    caseId: c.caseId,
    action: "needs-review",
    reason: `${ageDays.toFixed(0)}d old, no PB match, no accession # to feed a scraper. Manual triage needed.`,
    confidence: "low",
  };
}
