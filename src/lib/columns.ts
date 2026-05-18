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
  closed: "Protocol received",
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
  9: "ROF Allison email sent (she will proofread)",
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

/**
 * Multi-lab patient placement: a patient with multiple lab cases sits in the
 * column of their *least-progressed* lab — the bottleneck — so the board
 * surfaces "what needs to happen next for this patient." The exception:
 * "closed" only when every lab is closed; one closed lab + one in-progress
 * lab keeps the patient in the in-progress column.
 */
export function getColumnForPatient(cases: LabCase[]): ColumnKey {
  if (cases.length === 0) return "untouched";
  let minIdx = COLUMN_ORDER.length;
  let minCol: ColumnKey = "closed";
  for (const c of cases) {
    const col = getColumnFor(c);
    const idx = COLUMN_ORDER.indexOf(col);
    if (idx >= 0 && idx < minIdx) {
      minIdx = idx;
      minCol = col;
    }
  }
  return minCol;
}

/**
 * Coarser 4-bucket view used by the By-patient board. The 7-column model is
 * granular enough that moving a single lab one step rarely shifts the
 * patient's bottleneck column — visually it looks like "nothing happened."
 * Collapsing to New / At Lab / Results / Done means most lab moves cross a
 * patient-level boundary, so the board reacts to the action.
 *
 * By-lab and Tracking still use the full 7 columns — granularity matters
 * when you're working a single lab at a time.
 */
export type PatientColumnKey = "p_new" | "p_at_lab" | "p_results" | "p_done";

export const PATIENT_COLUMN_ORDER: PatientColumnKey[] = [
  "p_new",
  "p_at_lab",
  "p_results",
  "p_done",
];

export const PATIENT_COLUMN_LABEL: Record<PatientColumnKey, string> = {
  p_new: "New",
  p_at_lab: "At Lab",
  p_results: "Results",
  p_done: "Done",
};

const COL_TO_PATIENT_COL: Record<ColumnKey, PatientColumnKey> = {
  untouched: "p_new",
  sample_sent: "p_at_lab",
  partial_results: "p_at_lab",
  complete_results: "p_results",
  rof_scheduled: "p_results",
  rof_done: "p_results",
  closed: "p_done",
};

export function getPatientColumnForCase(c: LabCase): PatientColumnKey {
  return COL_TO_PATIENT_COL[getColumnFor(c)];
}

export function getPatientColumnForPatient(cases: LabCase[]): PatientColumnKey {
  if (cases.length === 0) return "p_new";
  let minIdx = PATIENT_COLUMN_ORDER.length;
  let minCol: PatientColumnKey = "p_done";
  for (const c of cases) {
    const col = getPatientColumnForCase(c);
    const idx = PATIENT_COLUMN_ORDER.indexOf(col);
    if (idx >= 0 && idx < minIdx) {
      minIdx = idx;
      minCol = col;
    }
  }
  return minCol;
}

export type PatientGroup = {
  patientEmail: string;
  patientName: string;
  cases: LabCase[];
};

/**
 * Group lab cases by patient email (the de facto patient identity). Cases
 * within a group are sorted by lab_name then panel for stable display.
 * Groups are returned in insertion order.
 */
export function groupByPatient(rows: LabCase[]): PatientGroup[] {
  const map = new Map<string, PatientGroup>();
  for (const row of rows) {
    const key = row.patient_email.trim().toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = {
        patientEmail: row.patient_email,
        patientName: row.patient_name,
        cases: [],
      };
      map.set(key, g);
    }
    g.cases.push(row);
  }
  for (const g of map.values()) {
    g.cases.sort((a, b) => {
      const labCmp = (a.lab_name || "").localeCompare(b.lab_name || "");
      if (labCmp !== 0) return labCmp;
      return (a.lab_panel || "").localeCompare(b.lab_panel || "");
    });
  }
  return [...map.values()];
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

/** Days from local-today to an ISO date (YYYY-MM-DD). Negative = past. */
export function daysFromTodayIso(iso: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + "T00:00:00");
  if (Number.isNaN(target.getTime())) return 0;
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export type ExpectedCountdown = {
  label: string;
  tone: "ok" | "due" | "overdue";
  days: number;
};

/**
 * "How long until / since the expected result date." Returns null when the
 * case already has complete results in (step 4), or when there's no expected
 * date on file. Tones drive card badge colors.
 */
export function expectedCountdown(c: LabCase): ExpectedCountdown | null {
  if (c.step4_complete_received) return null;
  if (!c.expected_result_at_max) return null;
  const d = daysFromTodayIso(c.expected_result_at_max);
  if (d < 0) return { label: `overdue ${Math.abs(d)}d`, tone: "overdue", days: d };
  if (d === 0) return { label: "due today", tone: "due", days: 0 };
  if (d <= 2) return { label: `in ${d}d`, tone: "due", days: d };
  return { label: `in ${d}d`, tone: "ok", days: d };
}

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
