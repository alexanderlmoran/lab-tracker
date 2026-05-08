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

  async function onToggle(step: StepNumber, next: boolean) {
    setError(null);

    // Email gate: ticking an email step opens the confirmation dialog.
    // The dialog handles sending + step-marking via its own server actions
    // (sendPatientEmail / skipPatientEmail), so we just refresh the local
    // boolean from the result and don't call setStepCompleted ourselves.
    if (next && isEmailStep(step)) {
      const kind = emailKindForStep(step);
      if (kind && emailDialogRef.current) {
        const result = await emailDialogRef.current.open({
          caseId: c.id,
          kind,
        });
        if (result.cancelled) return;
        // Either sent or skipped — both flip the step server-side.
        setC((prev) => ({ ...prev, [DB_COL[step]]: true }) as LabCase);
        return;
      }
    }

    // Non-email step OR unticking — write directly.
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

  return (
    <>
      <div className="space-y-1">
        {STEPS.map((step) => {
          const checked = stepIsComplete(c, step);
          const partialDisabled = !c.partial_expected && (step === 2 || step === 3);
          const isEmail = isEmailStep(step);
          const isPending = pendingStep === step;

          return (
            <label
              key={step}
              className={`flex items-start gap-3 rounded-md px-2 py-2 text-sm ${
                partialDisabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-zinc-50"
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                checked={checked}
                disabled={partialDisabled || isPending}
                onChange={(e) => {
                  void onToggle(step, e.target.checked);
                }}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-zinc-900 ${
                      checked ? "line-through decoration-zinc-400" : ""
                    }`}
                  >
                    {step}. {stepLabel(step)}
                  </span>
                  {isEmail ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                      email confirm
                    </span>
                  ) : null}
                  {partialDisabled ? (
                    <span className="text-[11px] text-zinc-500">(skip)</span>
                  ) : null}
                </div>
              </div>
            </label>
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
