import type { LabCase, StepNumber } from "./types";
import type { ColumnKey } from "./columns";
import { stepIsComplete } from "./columns";
import { emailKindForStep } from "./email/step-map";
import type { PatientEmailKind } from "./email/step-map";

// What does it take to make a card sit in the target column?
// We tick the column's "defining step(s)" if not already done. Earlier
// intermediate steps are NOT auto-ticked — operator manages those manually
// from the modal. This keeps DnD predictable and prevents accidentally
// firing N email confirmations from one drop.
const COLUMN_DEFINING_STEPS: Record<ColumnKey, StepNumber[]> = {
  untouched: [],
  // ready_to_ship is a derived state (tracking # attached, step 1 not yet
  // ticked) — there's no step to flip, and you can't drag a card here (it
  // needs a tracking number). Like pending_upload, it's not a jump target.
  ready_to_ship: [],
  // with_patient is staff-set (a `with_patient_at` timestamp, not a numbered
  // step) — set it via the "Given to patient" control in the checklist, not a
  // step-based column jump. No defining step ⇒ not offered in the move menu.
  with_patient: [],
  sample_sent: [1],
  complete_results: [5],
  // pending_upload is a derived state (PDF attached, awaiting Approve click);
  // it's not a drag-and-drop target — staff resolves it via the approval modal.
  pending_upload: [],
  rof_scheduled: [6],
  rof_done: [7],
  closed: [8, 9],
  // `completed` means archived — there is no step to tick. Jumping here is
  // not offered in the menu, but the key is required by the typed record.
  completed: [],
};

// A column is a valid "Move to" target only if reaching it ticks a step. The
// derived lanes — untouched (TODO), ready_to_ship (auto on tracking #), and
// pending_upload (auto on PDF staged / partial received) — have no defining
// step, so jumping to them does nothing. Hide them from the move menu instead
// of offering a dead option (you reach Ready to ship by adding a tracking #).
export function isColumnJumpTarget(col: ColumnKey): boolean {
  return (COLUMN_DEFINING_STEPS[col]?.length ?? 0) > 0;
}

export type StepPlan = {
  step: StepNumber;
  isEmailStep: boolean;
  emailKind: PatientEmailKind | null;
  alreadyComplete: boolean;
};

export function planColumnJump(
  row: LabCase,
  target: ColumnKey,
): StepPlan[] {
  const steps = COLUMN_DEFINING_STEPS[target] ?? [];
  return steps.map((step) => {
    const kind = emailKindForStep(step);
    return {
      step,
      isEmailStep: kind !== null,
      emailKind: kind,
      alreadyComplete: stepIsComplete(row, step),
    };
  });
}

export function isForwardJump(from: ColumnKey, to: ColumnKey): boolean {
  const order: ColumnKey[] = [
    "untouched",
    "ready_to_ship",
    "with_patient",
    "sample_sent",
    "complete_results",
    "rof_scheduled",
    "rof_done",
    "closed",
    "completed",
  ];
  return order.indexOf(to) > order.indexOf(from);
}
