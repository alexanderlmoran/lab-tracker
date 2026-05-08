import type { EmailKind, StepNumber } from "@/lib/types";

export const STEP_TO_EMAIL: Partial<Record<StepNumber, EmailKind>> = {
  1: "sample_sent",
  3: "partial_uploaded",
  5: "complete_uploaded",
  7: "rof_followup",
};

export const EMAIL_TO_STEP: Record<EmailKind, StepNumber> = {
  sample_sent: 1,
  partial_uploaded: 3,
  complete_uploaded: 5,
  rof_followup: 7,
};

export function emailKindForStep(step: StepNumber): EmailKind | null {
  return STEP_TO_EMAIL[step] ?? null;
}
