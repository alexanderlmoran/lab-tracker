import type { LabCase, StepNumber } from "./types";
import { isReadyToShip } from "./labs/pickup";

export type ColumnKey =
  | "untouched"
  | "ready_to_ship"
  | "sample_sent"
  | "partial_results"
  | "complete_results"
  | "pending_upload"
  | "rof_scheduled"
  | "rof_done"
  | "closed"
  | "completed";

// Workflow column order — drives the column-jump menu and progression UI.
// `completed` is intentionally excluded: it's an archive bucket, not a
// step you "jump" to from the menu. The By-Lab board uses
// LAB_BOARD_COLUMN_ORDER below to append it.
// Order reflects the natural lifecycle of a card. Pending Upload sits right
// after Sample Sent because that's the lane staff most need to monitor —
// it's where human approval is owed. A card with both partial + complete
// results passes through Pending Upload TWICE: once when partial arrives
// (then → Partial Uploaded) and again when complete arrives (then →
// Complete Uploaded). That intentional "back to Pending" surfaces the work.
export const COLUMN_ORDER: ColumnKey[] = [
  "untouched",
  "ready_to_ship",
  "sample_sent",
  "pending_upload",
  "partial_results",
  "complete_results",
  "rof_scheduled",
  "rof_done",
  "closed",
];

export const LAB_BOARD_COLUMN_ORDER: ColumnKey[] = [
  ...COLUMN_ORDER,
  "completed",
];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  untouched: "TODO",
  // Sample drawn + return label printed, packed and waiting at the clinic for
  // the carrier. A card rests here until FedEx scans it (step 1 auto-ticks on
  // the pickup/in-transit scan). This is the ONLY set the pickup dialog books.
  ready_to_ship: "Ready to Ship",
  sample_sent: "Sample Sent",
  // "Uploaded" labels emphasize the PB-side outcome (not merely "we got the
  // data back"). A card only lands in these lanes once the PDF actually
  // landed on the patient's PB chart. Pre-upload states sit in Pending Upload.
  partial_results: "Partial Uploaded",
  complete_results: "Complete Uploaded",
  pending_upload: "Pending Upload",
  rof_scheduled: "ROF Scheduled",
  rof_done: "ROF Done",
  closed: "Protocol received",
  completed: "Completed",
};

// Step names read in the same vocabulary as the board columns they feed, so
// the checklist and the lane a card sits in agree (e.g. step 3 → "Partial
// Uploaded" lane, step 6/7 → the "ROF" lanes). Keep the column word first
// ("Sample sent", "Partial uploaded", "ROF scheduled") and any email/where
// detail after, matching COLUMN_LABEL above.
const STEP_LABELS: Record<StepNumber, string> = {
  1: "Sample sent to lab",
  2: "Partial results received",
  3: "Partial uploaded → Email 2",
  4: "Complete results received",
  5: "Complete uploaded → Email 3",
  6: "ROF scheduled in Zenoti",
  7: "ROF done → Email 4",
  8: "Protocol emailed to patient",
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

// ── Per-lab workflow shapes ────────────────────────────────────────────
//
// The default 9-step pipeline is built for labs that mail a sample kit and
// return results. Peptides aren't labs — we ship a product to the patient
// and they receive it. The whole partial/complete/ROF chain doesn't apply.
// We model that as a separate workflow that reuses two of the existing
// boolean columns (step1 + step4) so no schema change is needed:
//   • step1_sample_sent      → "Shipped to patient" (fires the Peptides email)
//   • step4_complete_received → "Patient received package" (closes the case)
//
// New shapes can be added here. Each is a subset of the 9-step DB columns
// plus per-step relabels.

export type CaseWorkflow = "default" | "peptides";

type CaseLike = Pick<LabCase, "lab_name">;

export function getCaseWorkflow(row: CaseLike): CaseWorkflow {
  if (row.lab_name === "Peptides") return "peptides";
  return "default";
}

const WORKFLOW_STEPS: Record<CaseWorkflow, StepNumber[]> = {
  default: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  peptides: [1, 4],
};

const PEPTIDES_STEP_LABELS: Partial<Record<StepNumber, string>> = {
  1: "Shipped to patient → Email",
  4: "Patient received package",
};

/** Optional column subset for the per-lab process strip. Peptides shows
 * only three lanes (Untouched → Shipped → Received); default keeps all 7.
 * `completed` (archived) is not part of either strip — it's a board-level
 * bucket, not a workflow step. */
const WORKFLOW_COLUMNS: Record<CaseWorkflow, ColumnKey[]> = {
  default: ["untouched", "ready_to_ship", "sample_sent", "partial_results", "complete_results", "pending_upload", "rof_scheduled", "rof_done", "closed"],
  // Peptides ship a product TO the patient — there's no return sample to stage,
  // so the ready-to-ship lane doesn't apply.
  peptides: ["untouched", "sample_sent", "closed"],
};

const PEPTIDES_COLUMN_LABELS: Partial<Record<ColumnKey, string>> = {
  sample_sent: "Shipped",
  closed: "Received",
};

export function getWorkflowSteps(workflow: CaseWorkflow): StepNumber[] {
  return WORKFLOW_STEPS[workflow];
}

export function getWorkflowColumns(workflow: CaseWorkflow): ColumnKey[] {
  return WORKFLOW_COLUMNS[workflow];
}

export function stepLabelForWorkflow(
  workflow: CaseWorkflow,
  step: StepNumber,
): string {
  if (workflow === "peptides") {
    const override = PEPTIDES_STEP_LABELS[step];
    if (override) return override;
  }
  return STEP_LABELS[step];
}

export function columnLabelForWorkflow(
  workflow: CaseWorkflow,
  col: ColumnKey,
): string {
  if (workflow === "peptides") {
    const override = PEPTIDES_COLUMN_LABELS[col];
    if (override) return override;
  }
  return COLUMN_LABEL[col];
}

export function stepIsComplete(c: LabCase, step: StepNumber): boolean {
  return Boolean(c[STEP_TO_COL[step]]);
}

export function completedStepCount(c: LabCase): number {
  // Counts only steps relevant to the case's workflow so the "X of N"
  // display matches what the user actually sees in the checklist.
  const steps = getWorkflowSteps(getCaseWorkflow(c));
  let n = 0;
  for (const s of steps) {
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

/**
 * Optional per-case attachment state. When the scraper has attached a PDF
 * to a case but no human has approved/disapproved it yet, the case surfaces
 * in the "Pending Upload" column instead of "Complete Results" so staff can
 * see at a glance what needs their click. Derived from joins against
 * `lab_case_pdfs` and `lab_case_audit`; absence of the arg = old behavior.
 */
export type CaseAttachmentState = {
  hasPendingPdf: boolean;
};

export function getColumnFor(
  c: LabCase,
  attachment?: CaseAttachmentState,
): ColumnKey {
  // Archived cases live in the terminal "Completed" lane regardless of which
  // workflow they came from — once archived, they're done.
  if (c.archived_at) return "completed";
  // Peptides workflow: shipped → received. Step 4 alone closes the card —
  // none of the partial/complete/ROF lanes apply.
  if (getCaseWorkflow(c) === "peptides") {
    if (c.step4_complete_received) return "closed";
    if (c.step1_sample_sent) return "sample_sent";
    return "untouched";
  }
  if (c.step8_protocol_emailed && c.step9_sales_followup) return "closed";
  if (c.step7_rof_completed) return "rof_done";
  if (c.step6_rof_scheduled) return "rof_scheduled";

  // Column placement is now pure step-state. The lane names match the
  // BOOLEAN they require, so a "Partial Uploaded" card has step3 truly
  // flipped, not just "lab told us about it". Any intermediate state
  // (received-but-not-yet-uploaded, scraper-hasn't-attached-PDF-yet,
  // worker-in-flight) lives in Pending Upload until the relevant step
  // boolean flips. The `attachment` arg is no longer consulted here —
  // it remains for backwards compatibility with callers that still
  // pass it.
  if (c.step5_complete_uploaded) return "complete_results";
  if (c.step4_complete_received) return "pending_upload"; // complete received, awaiting upload
  if (c.step3_partial_uploaded) return "partial_results";
  if (c.step2_partial_received) return "pending_upload"; // partial received, awaiting upload
  if (c.step1_sample_sent) return "sample_sent";
  // Tracking # attached but not yet sent (step 1 unticked) → packed and waiting
  // for the carrier. See isReadyToShip for why this isn't keyed off tracking_status.
  if (isReadyToShip(c)) return "ready_to_ship";
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
  p_new: "TODO",
  p_at_lab: "At Lab",
  p_results: "Results",
  p_done: "Done",
};

const COL_TO_PATIENT_COL: Record<ColumnKey, PatientColumnKey> = {
  untouched: "p_new",
  // Pre-shipment (label printed, sample not yet at the lab) → still the
  // earliest patient bucket alongside not-started.
  ready_to_ship: "p_new",
  sample_sent: "p_at_lab",
  partial_results: "p_at_lab",
  complete_results: "p_results",
  pending_upload: "p_results",
  rof_scheduled: "p_results",
  rof_done: "p_results",
  closed: "p_done",
  completed: "p_done",
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

export type DateGroup = {
  /** ISO collection_date, or null for the "no date yet" bucket. */
  date: string | null;
  cases: LabCase[];
};

/**
 * Group a patient's cases by collection DATE — patients commonly draw 2–7
 * labs in one sitting (often one shipped box), so a shared collection_date is
 * the de facto "this batch went out together" key. Cases with no date land in
 * a single trailing `null` bucket. Dated buckets are sorted newest-first;
 * within a bucket, lab_name then panel (matching `groupByPatient`'s order).
 *
 * Shared so the By-patient card (#16) and merge-by-date (#17) reason about the
 * same batches — don't reimplement date bucketing elsewhere.
 */
export function groupByDate(cases: LabCase[]): DateGroup[] {
  const map = new Map<string, LabCase[]>();
  for (const c of cases) {
    const key = c.collection_date ?? "";
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  const dated: DateGroup[] = [];
  let undated: DateGroup | null = null;
  for (const [key, arr] of map) {
    arr.sort((a, b) => {
      const labCmp = (a.lab_name || "").localeCompare(b.lab_name || "");
      if (labCmp !== 0) return labCmp;
      return (a.lab_panel || "").localeCompare(b.lab_panel || "");
    });
    if (key === "") undated = { date: null, cases: arr };
    else dated.push({ date: key, cases: arr });
  }
  // Newest draw first; the dateless bucket always trails.
  dated.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return undated ? [...dated, undated] : dated;
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
