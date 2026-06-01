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
  /** When null, the case is NOT linked to a Zenoti appointment — typically
   * a bulk-imported historical row. Such rows often have null collectionDate
   * but represent labs collected months ago, so the grace window doesn't
   * apply. */
  zenotiAppointmentId: string | null;
  /** Lab order/accession number, if staff entered it. */
  labExternalRef: string | null;
  /** Optional secondary name to try when labName itself is generic
   * (e.g. "Custom", "Other"). Typically the CSV "contents" field —
   * "vaginal microbiome", "telomere", etc. PB labrequest names sometimes
   * embed the panel rather than the carrier ("MicrogenDX Results",
   * "Life Length Telomere Test"), so matching against the panel string
   * recovers those cases. Hint-only matches are capped at medium
   * confidence — the hint is operator-typed and fuzzy. */
  panelHint?: string | null;
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

/** Days between two YYYY-MM-DD strings (or YYYY-MM-DDTxx ISO). Absolute value.
 *  Returns NaN if either date is unparseable — callers must guard. */
function daysBetween(a: string, b: string): number {
  const da = new Date(a.slice(0, 10) + "T00:00:00Z").getTime();
  const db = new Date(b.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.abs(da - db) / 86400000;
}

/** Signed days from `anchorIso` to `nowIso`: positive = anchor in the past,
 *  negative = anchor in the future. Unlike daysBetween, the sign matters for
 *  the grace window — a future collection date is still pending, not "aged". */
function signedDaysSince(anchorIso: string, nowIso: string): number {
  const a = new Date(anchorIso.slice(0, 10) + "T00:00:00Z").getTime();
  const n = new Date(nowIso.slice(0, 10) + "T00:00:00Z").getTime();
  return (n - a) / 86400000;
}

function normalizeLabName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A normalized lab name shorter than this is too generic to substring-match
// safely: "dx" lives inside "microgendx", "a" inside almost anything. Real
// providers are ≥4 chars ("RGCC", "Dutch"), so this never blocks a real lab.
const MIN_NAME_MATCH_CHARS = 3;

/** Does the PB labrequest name reference the same lab destination as
 *  the tracker case's lab_name? Substring match on normalized strings —
 *  PB names are like "Access — Acc# 007143558" or "Access Custom",
 *  tracker lab_names are like "Access". */
function labNameMatches(caseLab: string, pbName: string): boolean {
  const a = normalizeLabName(caseLab);
  const b = normalizeLabName(pbName);
  if (!a || !b) return false;
  // Guard against a tiny string incidentally living inside a longer one.
  if (Math.min(a.length, b.length) < MIN_NAME_MATCH_CHARS) return false;
  return b.includes(a) || a.includes(b);
}

// Filler words that carry no lab-identity signal. Sharing one of these
// between a tracker case and a PB name must NOT count as a match — otherwise
// "Custom Lab Test" would match "Other Results Panel".
const STOPWORDS = new Set([
  "lab", "labs", "test", "tests", "result", "results", "panel", "panels",
  "custom", "other", "kit", "kits", "profile", "comprehensive", "complete",
  "draw", "blood", "serum", "sample", "samples", "center", "centre", "with",
  "and", "for", "the", "request", "report", "results",
]);

/** Significant words in a name: ≥4 chars, lowercased, stopwords removed.
 *  Used for token-overlap matching when substring matching fails because
 *  the words appear in a different order ("vaginal microbiome" vs
 *  "Microbiome Labs (BIOMEFX)"). */
function contentWords(s: string): string[] {
  return normalizeLabName(s)
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** True if the case strings and the PB name share at least one content word.
 *  The fuzziest match signal — only ever yields LOW confidence so it never
 *  auto-advances; its job is to surface a candidate for a human to eyeball. */
function tokenOverlap(caseStrings: string, pbName: string): boolean {
  const a = new Set(contentWords(caseStrings));
  if (a.size === 0) return false;
  return contentWords(pbName).some((w) => a.has(w));
}

// Accession identity matching. A ref must be a *whole token* of the PB name
// (not an incidental substring of a longer number — "770000" ⊄ "7700001"), and
// long enough to be a real order number ("55" is noise). 6+ chars covers every
// accession we've seen (9-digit Access, alphanumeric specialty labs).
const MIN_ACCESSION_CHARS = 6;

/** Alphanumeric tokens of a name, lowercased: "Access — Acc# 007143558" →
 *  ["access", "acc", "007143558"]. */
function nameTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whole-token, length-gated accession match between a case ref and a PB name. */
function accessionMatches(ref: string | null, pbName: string): boolean {
  const r = (ref ?? "").trim().toLowerCase();
  if (r.length < MIN_ACCESSION_CHARS) return false;
  return nameTokens(pbName).includes(r);
}

/** Maximum age (days) between tracker collection_date and PB orderdate that
 *  the matcher will still consider. Specialty labs (telomere, infection
 *  panels, microbiome) can take 60+ days to result, so we go well past
 *  the typical 14-21d turnaround. Anything older than this is almost
 *  certainly not the same lab — different staff would have re-ordered. */
const MAX_DATE_WINDOW_DAYS = 90;

/** Find the best PB labrequest for a tracker case. Match logic:
 *   1. Lab name OR panel hint substring-matches the PB name, OR a content
 *      word overlaps (token match) when substring fails on word ordering.
 *   2. Date proximity: PB orderdate within ±MAX_DATE_WINDOW_DAYS of tracker
 *      collection_date (fallback: createdAt). Closer = better.
 *   3. Accession # in both names overrides everything → high.
 *  Candidates are ranked by signal strength first (accession > name/hint >
 *  token), then by date proximity — so a close-but-fuzzy token match never
 *  beats a genuine name match.
 *  Returns the best candidate + confidence, or null if nothing plausible. */
export function matchCaseToPbLabRequest(
  c: BackfillCase,
  candidates: PbLabRequest[],
): { match: PbLabRequest; confidence: "low" | "medium" | "high" } | null {
  if (candidates.length === 0) return null;
  const anchorIso = c.collectionDate ?? c.createdAt;
  const anchor = anchorIso.slice(0, 10);
  // Bulk-import historicals (no Zenoti link, no collection date) anchor on
  // createdAt = the spreadsheet insert time, NOT when the lab happened. Date
  // proximity is therefore meaningless for them: skip the date window, and cap
  // confidence below (only a unique accession identity earns high).
  const isBulkImportHistorical = !c.zenotiAppointmentId && !c.collectionDate;
  // labName + panelHint feed token matching together.
  const tokenSource = [c.labName, c.panelHint].filter(Boolean).join(" ");

  type Cand = {
    lr: PbLabRequest;
    daysOff: number;
    nameHit: boolean;
    hintHit: boolean;
    tokenHit: boolean;
    accHit: boolean;
    strength: number;
  };
  let best: Cand | null = null;
  for (const lr of candidates) {
    const nameHit = labNameMatches(c.labName, lr.name);
    const hintHit = !!c.panelHint && labNameMatches(c.panelHint, lr.name);
    // Token overlap is a fallback only — skip the work if a stronger signal
    // already fired.
    const tokenHit = nameHit || hintHit ? true : tokenOverlap(tokenSource, lr.name);
    // Whole-token, length-gated accession identity (see accessionMatches).
    const accHit = accessionMatches(c.labExternalRef, lr.name);
    if (!nameHit && !hintHit && !tokenHit && !accHit) continue;
    // Bulk-import historicals have no date to corroborate a weak token-only
    // hit — require a real identity signal (name / hint / accession) for them.
    if (isBulkImportHistorical && !nameHit && !hintHit && !accHit) continue;

    let daysOff = Number.POSITIVE_INFINITY;
    if (lr.dateOrdered) {
      const d = daysBetween(anchor, lr.dateOrdered);
      if (Number.isFinite(d)) daysOff = d; // unparseable date → treat as missing
    }
    // Date-window exclusion. For reliable anchors, a candidate outside ±90d
    // isn't the same lab — accession included (a 2-year-old accession must lose
    // to a fresh name match). Bulk imports skip this (anchor is meaningless).
    if (!isBulkImportHistorical && daysOff > MAX_DATE_WINDOW_DAYS) continue;

    // Strength: accession beats name/hint beats token-only.
    const strength = accHit ? 3 : nameHit || hintHit ? 2 : 1;
    const cand: Cand = { lr, daysOff, nameHit, hintHit, tokenHit, accHit, strength };
    if (
      !best ||
      (cand.accHit && !best.accHit) ||
      (cand.accHit === best.accHit && cand.strength > best.strength) ||
      (cand.accHit === best.accHit && cand.strength === best.strength && cand.daysOff < best.daysOff)
    ) {
      best = cand;
    }
  }

  if (!best) return null;

  // Confidence ladder. Accession beats everything. labName matches use the
  // tight 0-7/8-21/22-90 ladder. Hint-only matches are capped at medium
  // because the panel string is operator-typed and fuzzy. Token-only matches
  // are always LOW — a shared word means "maybe; a human must look" and must
  // never auto-advance.
  let confidence: "low" | "medium" | "high" = "low";
  if (best.accHit) confidence = "high";
  else if (best.nameHit && best.daysOff <= 7) confidence = "high";
  else if (best.nameHit && best.daysOff <= 21) confidence = "medium";
  else if (best.hintHit && best.daysOff <= 21) confidence = "medium";
  // token-only matches, and name/hint matches beyond 21 days, stay "low"

  // Bulk-import historicals can't use date proximity to justify high — the
  // anchor is the insert date. Only a unique accession identity earns high; a
  // name/hint "high" here would be coincidental, so cap it at medium.
  if (isBulkImportHistorical && !best.accHit && confidence === "high") {
    confidence = "medium";
  }

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

  // Compute age. EXCEPTION for bulk-imported historicals: cases with no
  // zenoti_appointment_id AND no collection_date are CSV-imports from
  // spreadsheets — the created_at is when the row was inserted, not when
  // the lab happened. For those we treat age as effectively infinite so
  // they skip the grace window and proceed to PB lookup directly.
  const isBulkImportHistorical = !c.zenotiAppointmentId && !c.collectionDate;
  const anchorIso = c.collectionDate ?? c.createdAt;
  const anchor = anchorIso.slice(0, 10);
  // Signed age: positive = past, negative = future. A future collection date
  // means the sample hasn't been drawn yet — still pending. (The old abs()
  // math made future dates look aged and wrongly advanced them.)
  const ageDays = isBulkImportHistorical
    ? Number.POSITIVE_INFINITY
    : signedDaysSince(anchorIso, now.toISOString());

  // Skip cases newer than the grace window — they might still be in
  // legitimate flight (sample mailed yesterday) — or dated in the future.
  if (ageDays < GRACE_DAYS) {
    return {
      caseId: c.caseId,
      action: "leave",
      reason:
        ageDays < 0
          ? `Collection date ${anchor} is in the future — sample not yet collected.`
          : `Only ${ageDays.toFixed(0)} days old (<${GRACE_DAYS}d grace) — legitimately pending.`,
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

  const ageLabel = Number.isFinite(ageDays) ? `${ageDays.toFixed(0)}d` : "bulk-import (age unknown)";
  return {
    caseId: c.caseId,
    action: "needs-review",
    reason: `${ageLabel} old, no PB match, no accession # to feed a scraper. Manual triage needed.`,
    confidence: "low",
  };
}
