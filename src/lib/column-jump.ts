import type { LabCase, StepNumber, EmailKind } from "./types";
import type { ColumnKey } from "./columns";
import { stepIsComplete } from "./columns";
import { emailKindForStep } from "./email/step-map";

// What does it take to make a card sit in the target column?
// We tick the column's "defining step(s)" if not already done. Earlier
// intermediate steps are NOT auto-ticked — operator manages those manually
// from the modal. This keeps DnD predictable and prevents accidentally
// firing N email confirmations from one drop.
const COLUMN_DEFINING_STEPS: Record<ColumnKey, StepNumber[]> = {
  untouched: [],
  sample_sent: [1],
  partial_results: [3],
  complete_results: [5],
  rof_scheduled: [6],
  rof_done: [7],
  closed: [8, 9],
};

export type StepPlan = {
  step: StepNumber;
  isEmailStep: boolean;
  emailKind: EmailKind | null;
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
  const order = [
    "untouched",
    "sample_sent",
    "partial_results",
    "complete_results",
    "rof_scheduled",
    "rof_done",
    "closed",
  ] as const;
  return order.indexOf(to) > order.indexOf(from);
}
