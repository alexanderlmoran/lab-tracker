"use client";

import { useRef, useState, useTransition } from "react";
import type { LabCase, StepNumber } from "@/lib/types";
import { isEmailStep, stepIsComplete, stepLabel } from "@/lib/columns";
import { emailKindForStep } from "@/lib/email/step-map";
import { setStepCompleted } from "./actions";
import { EmailConfirmDialog, type EmailConfirmHandle } from "./EmailConfirmDialog";

const STEPS: StepNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const DB_COL: Record<StepNumber, keyof LabCase> = {
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

export function StepChecklist({ initial }: { initial: LabCase }) {
  const [c, setC] = useState<LabCase>(initial);
  const [pendingStep, setPendingStep] = useState<StepNumber | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const emailDialogRef = useRef<EmailConfirmHandle | null>(null);

  // Step toggles just toggle. Patient emails are sent via the explicit
  // "Send email" button next to each email step — clicking the step itself
  // never fires email. This was a UX request: the auto-prompt on tick felt
  // like the email was going out on click, and made it tedious to backfill
  // completed steps after the fact.
  function onToggle(step: StepNumber, next: boolean) {
    setError(null);
    setPendingStep(step);
    setC((prev) => ({ ...prev, [DB_COL[step]]: next }) as LabCase);
    startTransition(async () => {
      const res = await setStepCompleted({
        caseId: c.id,
        step,
        completed: next,
      });
      setPendingStep(null);
      if (!res.ok) {
        setError(res.error);
        setC((prev) => ({ ...prev, [DB_COL[step]]: !next }) as LabCase);
      }
    });
  }

  async function onSendEmail(step: StepNumber) {
    const kind = emailKindForStep(step);
    if (!kind || !emailDialogRef.current) return;
    setError(null);
    const result = await emailDialogRef.current.open({ caseId: c.id, kind });
    if (result.cancelled) return;
    // Both sent and skipped flip the step server-side — mirror locally.
    setC((prev) => ({ ...prev, [DB_COL[step]]: true }) as LabCase);
  }

  return (
    <>
      <div className="space-y-1">
        {STEPS.map((step) => {
          const checked = stepIsComplete(c, step);
          const partialDisabled = !c.partial_expected && (step === 2 || step === 3);
          const isEmail = isEmailStep(step);
          const isPending = pendingStep === step;

          return (
            <div
              key={step}
              className={`flex items-start gap-3 rounded-md px-2 py-2 text-sm ${
                partialDisabled ? "opacity-50" : "hover:bg-zinc-50"
              }`}
            >
              <label
                className={`flex flex-1 items-start gap-3 ${
                  partialDisabled ? "cursor-not-allowed" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                  checked={checked}
                  disabled={partialDisabled || isPending}
                  onChange={(e) => {
                    onToggle(step, e.target.checked);
                  }}
                />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-zinc-900 ${
                        checked ? "line-through decoration-zinc-400" : ""
                      }`}
                    >
                      {step}. {stepLabel(step)}
                    </span>
                    {partialDisabled ? (
                      <span className="text-[11px] text-zinc-500">(skip)</span>
                    ) : null}
                  </div>
                </div>
              </label>
              {isEmail && !partialDisabled ? (
                <button
                  type="button"
                  onClick={() => void onSendEmail(step)}
                  disabled={isPending}
                  className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  title="Open the email confirmation dialog"
                >
                  {checked ? "Resend email" : "Send email"}
                </button>
              ) : null}
            </div>
          );
        })}
        {error ? (
          <p className="px-2 text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <EmailConfirmDialog ref={emailDialogRef} />
    </>
  );
}
