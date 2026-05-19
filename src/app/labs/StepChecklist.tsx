"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { EmailKind, LabCase, StepNumber } from "@/lib/types";
import {
  getCaseWorkflow,
  getWorkflowSteps,
  isEmailStep,
  stepIsComplete,
  stepLabelForWorkflow,
} from "@/lib/columns";
import { emailKindForStep } from "@/lib/email/step-map";
import { setStepCompleted } from "./actions";
import { listEmailLogs } from "./email-actions";
import { EmailConfirmDialog, type EmailConfirmHandle } from "./EmailConfirmDialog";


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
  const workflow = getCaseWorkflow(c);
  const stepsToShow = getWorkflowSteps(workflow);

  // Track the most recent successful send timestamp per email kind. Drives
  // the Send vs Resend label so cascading or ticking a step never claims
  // an email was sent when nothing was. Loaded once on mount + updated
  // locally after every send.
  const [lastSentAt, setLastSentAt] = useState<Partial<Record<EmailKind, string>>>({});
  useEffect(() => {
    let cancelled = false;
    listEmailLogs(c.id)
      .then((logs) => {
        if (cancelled) return;
        const map: Partial<Record<EmailKind, string>> = {};
        for (const log of logs) {
          if (log.status !== "sent") continue;
          const prev = map[log.kind];
          if (!prev || log.created_at > prev) map[log.kind] = log.created_at;
        }
        setLastSentAt(map);
      })
      .catch(() => {
        // Non-fatal — fall back to "Send email" everywhere if the fetch
        // fails. The actual email-confirm dialog still gates real sends.
      });
    return () => {
      cancelled = true;
    };
  }, [c.id]);

  // Step toggles just toggle. Patient emails are sent via the explicit
  // "Send email" button next to each email step — clicking the step itself
  // never fires email. This was a UX request: the auto-prompt on tick felt
  // like the email was going out on click, and made it tedious to backfill
  // completed steps after the fact.
  //
  // Forward toggles cascade: ticking step N auto-ticks every workflow-prior
  // step too, so backfilling a complete lab doesn't require clicking each
  // box. Backward toggles untick only the one step — to walk a case back,
  // the user uses successive unticks.
  function onToggle(step: StepNumber, next: boolean) {
    setError(null);
    setPendingStep(step);
    const optimisticUpdates: Record<string, boolean> = { [DB_COL[step]]: next };
    if (next) {
      for (const s of stepsToShow) {
        if (s < step) optimisticUpdates[DB_COL[s] as string] = true;
      }
    }
    setC((prev) => ({ ...prev, ...optimisticUpdates }) as LabCase);
    const prevSnapshot = c;
    startTransition(async () => {
      const res = await setStepCompleted({
        caseId: c.id,
        step,
        completed: next,
        cascadePrior: next,
      });
      setPendingStep(null);
      if (!res.ok) {
        setError(res.error);
        setC(prevSnapshot);
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
    // Only an actual send counts — skipped (e.g. template disabled)
    // shouldn't promote the button to "Resend".
    if (result.sent) {
      setLastSentAt((prev) => ({ ...prev, [kind]: new Date().toISOString() }));
    }
  }

  return (
    <>
      <div className="space-y-1">
        {stepsToShow.map((step, idx) => {
          const displayNum = idx + 1;
          const checked = stepIsComplete(c, step);
          // Step 4 is not normally an email step, but in the peptides
          // workflow it stands in for "package received" — closure, no
          // email. Only step 1 ever fires an email there.
          const isEmail = isEmailStep(step) && (workflow !== "peptides" || step === 1);
          const isPending = pendingStep === step;
          const isOptional = workflow === "default" && (step === 2 || step === 3);

          return (
            <div
              key={step}
              className="flex items-start gap-3 rounded-md px-2 py-2 text-sm hover:bg-zinc-50"
            >
              <label className="flex flex-1 items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                  checked={checked}
                  disabled={isPending}
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
                      {displayNum}. {stepLabelForWorkflow(workflow, step)}
                    </span>
                    {isOptional && !checked ? (
                      <span className="text-[11px] text-zinc-500">(optional)</span>
                    ) : null}
                  </div>
                </div>
              </label>
              {isEmail ? (() => {
                const kind = emailKindForStep(step);
                const sentAt = kind ? lastSentAt[kind] : undefined;
                const hasSent = Boolean(sentAt);
                const tooltip = hasSent
                  ? `Last sent ${new Date(sentAt!).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}`
                  : "No email sent yet — opens the confirmation dialog";
                return (
                  <button
                    type="button"
                    onClick={() => void onSendEmail(step)}
                    disabled={isPending}
                    className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    title={tooltip}
                  >
                    {hasSent ? "Resend email" : "Send email"}
                  </button>
                );
              })() : null}
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
