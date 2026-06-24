// Result-window math for "is this sample-sent case in scope to scrape yet?".
// Extracted from /api/worker/open-cases so the scrape feed AND the sample-sent
// triage diagnostic classify cases the SAME way (one source of truth).

import { findLabByName, predictResultDates } from "./catalog";

// Poll from delivery (or collection + EARLY_POLL_DAYS) — NOT the predicted
// earliest result date, since labs often return sooner than the catalog estimate.
export const EARLY_POLL_DAYS = 2;
// Keep probing up to GRACE_DAYS past the predicted max — a slow/late-entered case
// otherwise silently drops out of the feed and never auto-pulls again.
export const GRACE_DAYS = 60;
// Fallback turnaround when the catalog has no min/max for a lab.
const DEFAULT_TURNAROUND_MIN_DAYS = 7;
const DEFAULT_TURNAROUND_MAX_DAYS = 35;

const addDays = (anchorIso: string, days: number) =>
  new Date(new Date(anchorIso).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** The fields the window math reads — a subset of a lab_cases row. */
export type ResultWindowCase = {
  lab_name: string;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step4_complete_received: boolean;
  expected_result_at_min: string | null;
  expected_result_at_max: string | null;
  collection_date: string | null;
  tracking_delivered_at: string | null;
  created_at: string;
};

/** Effective [min, max] result window — delivery/import dates if set, else
 *  predicted from the catalog turnaround anchored on collection (or created). */
export function effectiveWindow(c: ResultWindowCase): { min: string | null; max: string | null } {
  if (c.expected_result_at_min) {
    return { min: c.expected_result_at_min, max: c.expected_result_at_max };
  }
  const anchor = c.collection_date ?? c.created_at.slice(0, 10);
  const entry = findLabByName(c.lab_name);
  const pred = entry ? predictResultDates(new Date(anchor), entry) : { minIso: null, maxIso: null };
  return {
    min: pred.minIso ?? addDays(anchor, DEFAULT_TURNAROUND_MIN_DAYS),
    max: pred.maxIso ?? addDays(anchor, DEFAULT_TURNAROUND_MAX_DAYS),
  };
}

/** The date polling STARTS: tracking delivery, else collection + EARLY_POLL_DAYS. */
export function pollStartsBy(c: ResultWindowCase): string {
  if (c.tracking_delivered_at) return c.tracking_delivered_at.slice(0, 10);
  const anchor = c.collection_date ?? c.created_at.slice(0, 10);
  return addDays(anchor, EARLY_POLL_DAYS);
}

/** True when a sample-sent, not-yet-received case is inside its scrape window
 *  (poll start reached, not past the grace floor). */
export function inResultWindow(c: ResultWindowCase, todayIso?: string): boolean {
  if (!c.step1_sample_sent || c.step2_partial_received || c.step4_complete_received) {
    return false;
  }
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  const graceFloor = new Date(Date.now() - GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { max } = effectiveWindow(c);
  return pollStartsBy(c) <= today && (!max || max >= graceFloor);
}

// ─────────────────────────────────────────────────────────────────────────
// Lost-kit detection (the high-value one — a FedEx kit went missing with no
// alert). Distinct from the generic stale-digest "overdue": a returned/exception
// shipment with no accession on file and no result PDF is a kit that almost
// certainly needs to be RE-ORDERED, not merely chased.
// ─────────────────────────────────────────────────────────────────────────

/** Extra fields the lost-kit signal reads beyond the window math. */
export type LostKitCase = ResultWindowCase & {
  tracking_status: string | null;
  lab_external_ref: string | null;
};

/** Days past the poll-start window before a sample-sent case with no result is
 *  old enough to flag as a likely-lost kit (vs. still in normal transit/turnaround). */
export const LOST_KIT_GRACE_DAYS = 7;

/** True when a sample-sent case looks like a LOST KIT that needs re-ordering —
 *  NOT just slow. Requires (caller supplies hasLivePdf=false, i.e. no result has
 *  landed):
 *    - sample sent, nothing received yet
 *    - past pollStartsBy + LOST_KIT_GRACE_DAYS (it's had time to come back)
 *    - tracking says the shipment went sideways: 'returned' or 'exception'
 *    - no accession on file (lab_external_ref is null) — the lab never got/logged it
 *  The tracking + no-accession combo is what makes this "reorder" rather than the
 *  generic "overdue" the stale digest already covers. The "no live PDF" check is
 *  the caller's (it needs a lab_case_pdfs lookup this pure helper can't do). */
export function isLikelyLostKit(c: LostKitCase, todayIso?: string): boolean {
  if (!c.step1_sample_sent || c.step2_partial_received || c.step4_complete_received) {
    return false;
  }
  if (c.lab_external_ref) return false; // lab logged the accession → it has the kit
  const status = (c.tracking_status ?? "").toLowerCase();
  if (status !== "returned" && status !== "exception") return false;
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  const overdueFloor = addDays(pollStartsBy(c), LOST_KIT_GRACE_DAYS);
  return overdueFloor <= today;
}
