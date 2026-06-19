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
