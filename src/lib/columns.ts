import type { LabCase, StepNumber } from "./types";

export type ColumnKey =
  | "sample_sent"
  | "partial_results"
  | "complete_results"
  | "rof_scheduled"
  | "rof_done"
  | "closed"
  | "untouched";

// Seven columns — a "New" column at the left holds cases that exist but
// haven't shipped yet (step 1 not ticked). Without it, brand-new cases
// would have no home.
export const COLUMN_ORDER: ColumnKey[] = [
  "untouched",
  "sample_sent",
  "partial_results",
  "complete_results",
  "rof_scheduled",
  "rof_done",
  "closed",
];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  untouched: "New",
  sample_sent: "Sample Sent",
  partial_results: "Partial Results",
  complete_results: "Complete Results",
  rof_scheduled: "ROF Scheduled",
  rof_done: "ROF Done",
  closed: "Closed",
};

const STEP_LABELS: Record<StepNumber, string> = {
  1: "Sample sent to lab",
  2: "Partial results received",
  3: "Partial uploaded → Email 2",
  4: "Complete results received",
  5: "Complete uploaded → Email 3",
  6: "Patient scheduled in Zenoti",
  7: "ROF confirmed → Email 4",
  8: "Patient emailed protocol",
  9: "Salesperson follow-up",
};

const STEP_TO_COL: Record<StepNumber, keyof LabCase> = {
  1: "step1_sample_sent",
  2: "step2_partial_received",
  3: "step3_partial_uploaded",
  4: "step4_complete_received",
  5: "step5_complete_uploaded",
  6: "step6_rof_scheduled",
  7: "step7_rof_completed",
  8: "step8_protocol_emailed",
  9: "step9_sales_followup",
};

export function stepLabel(step: StepNumber): string {
  return STEP_LABELS[step];
}

export function stepIsComplete(c: LabCase, step: StepNumber): boolean {
  return Boolean(c[STEP_TO_COL[step]]);
}

export function completedStepCount(c: LabCase): number {
  let n = 0;
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9] as StepNumber[]) {
    if (stepIsComplete(c, s)) n++;
  }
  return n;
}

export function highestCompletedStep(c: LabCase): number {
  let highest = 0;
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9] as StepNumber[]) {
    if (stepIsComplete(c, s)) highest = s;
  }
  return highest;
}

export function getColumnFor(c: LabCase): ColumnKey {
  if (c.step8_protocol_emailed && c.step9_sales_followup) return "closed";
  if (c.step7_rof_completed) return "rof_done";
  if (c.step6_rof_scheduled) return "rof_scheduled";
  if (c.step4_complete_received || c.step5_complete_uploaded)
    return "complete_results";
  if (c.step2_partial_received || c.step3_partial_uploaded)
    return "partial_results";
  if (c.step1_sample_sent) return "sample_sent";
  return "untouched";
}

export function isEmailStep(step: StepNumber): step is 1 | 3 | 5 | 7 {
  return step === 1 || step === 3 || step === 5 || step === 7;
}

const DEFAULT_STALE_DAYS = 7;

export function getStaleDaysThreshold(): number {
  const env = process.env.NEXT_PUBLIC_STALE_DAYS ?? process.env.STALE_DAYS;
  const n = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_DAYS;
}

export type CaseStaleness = {
  stale: boolean;
  daysSinceProgress: number;
};

/** Cases not yet fully closed and idle (`updated_at` is older than threshold)
 * are flagged stale. updated_at advances on any case mutation, so it's a
 * good proxy for "last progress." */
export function getCaseStaleness(
  c: LabCase,
  threshold: number = getStaleDaysThreshold(),
): CaseStaleness {
  if (c.archived_at || c.deleted_at) {
    return { stale: false, daysSinceProgress: 0 };
  }
  const closed = c.step8_protocol_emailed && c.step9_sales_followup;
  if (closed) return { stale: false, daysSinceProgress: 0 };
  const last = new Date(c.updated_at).getTime();
  const days = Math.floor((Date.now() - last) / 86400000);
  return { stale: days >= threshold, daysSinceProgress: days };
}
