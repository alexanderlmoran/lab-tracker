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
import { archiveLabCase, setStepCompleted, unarchiveLabCase } from "./actions";
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
  const [archiving, setArchiving] = useState(false);
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

  // "Completed" is the terminal stage = archived. Toggling it here archives /
  // unarchives the case (same as the Danger-zone button) so the step ladder is
  // complete and a case can be finished in one click from the checklist.
  function onToggleCompleted(next: boolean) {
    setError(null);
    setArchiving(true);
    const prevSnapshot = c;
    setC((prev) => ({ ...prev, archived_at: next ? new Date().toISOString() : null }) as LabCase);
    startTransition(async () => {
      const res = next ? await archiveLabCase(c.id) : await unarchiveLabCase(c.id);
      setArchiving(false);
      if (!res.ok) {
        setError(res.error);
        setC(prevSnapshot);
      }
    });
  }

  // Derived/terminal stages that bracket the numbered steps so the card's
  // ladder matches the board columns: Ready to ship (tracking attached, before
  // step 1) → 1–9 → Completed (archived). Ready-to-ship is read-only — it's
  // derived from the tracking #, not a toggle. Both are hidden for peptides'
  // trimmed ship→receive flow except Completed (any case can be archived).
  function StageRow({
    label,
    checked,
    derived,
    pending,
    onChange,
  }: {
    label: string;
    checked: boolean;
    derived?: boolean;
    pending?: boolean;
    onChange?: (next: boolean) => void;
  }) {
    return (
      <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
        <label className={`flex min-w-0 flex-1 items-center gap-2 ${derived ? "" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 rounded border-zinc-300"
            checked={checked}
            disabled={derived || pending}
            onChange={(e) => onChange?.(e.target.checked)}
          />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] italic text-zinc-600 ${
              checked ? "line-through decoration-zinc-400" : ""
            }`}
            title={label}
          >
            {label}
          </span>
        </label>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-500">
          {derived ? "auto" : "stage"}
        </span>
      </div>
    );
  }

  // Split into two columns: first half (1-5) left, second half (6+) right.
  // Indexes are 0-based here; idx + 1 stays the visible step number.
  const midpoint = Math.ceil(stepsToShow.length / 2);

  function renderStep(step: StepNumber, idx: number) {
    const displayNum = idx + 1;
    const checked = stepIsComplete(c, step);
    // Step 4 is not normally an email step, but in the peptides workflow it
    // stands in for "package received" — closure, no email. Only step 1
    // ever fires an email there.
    const isEmail = isEmailStep(step) && (workflow !== "peptides" || step === 1);
    const isPending = pendingStep === step;
    const isOptional = workflow === "default" && (step === 2 || step === 3);
    const kind = isEmail ? emailKindForStep(step) : null;
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
      <div
        key={step}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-zinc-50"
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 rounded border-zinc-300"
            checked={checked}
            disabled={isPending}
            onChange={(e) => {
              onToggle(step, e.target.checked);
            }}
          />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] text-zinc-900 ${
              checked ? "line-through decoration-zinc-400" : ""
            }`}
            title={stepLabelForWorkflow(workflow, step)}
          >
            {displayNum}. {stepLabelForWorkflow(workflow, step)}
            {isOptional && !checked ? (
              <span className="ml-1 text-[10px] text-zinc-500">(opt)</span>
            ) : null}
          </span>
        </label>
        {isEmail ? (
          <button
            type="button"
            onClick={() => void onSendEmail(step)}
            disabled={isPending}
            className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            title={tooltip}
          >
            {hasSent ? "Resend" : "Send"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {workflow === "default" ? (
        <StageRow
          label="Ready to ship — tracking # attached, waiting for carrier"
          checked={Boolean(c.tracking_number)}
          derived
        />
      ) : null}
      <div className="grid gap-x-4 gap-y-0 lg:grid-cols-2">
        <div className="flex flex-col">
          {stepsToShow.slice(0, midpoint).map((step, i) => renderStep(step, i))}
        </div>
        <div className="flex flex-col">
          {stepsToShow.slice(midpoint).map((step, i) =>
            renderStep(step, i + midpoint),
          )}
        </div>
      </div>
      <StageRow
        label="Completed — archived to the Completed lane"
        checked={Boolean(c.archived_at)}
        pending={archiving}
        onChange={onToggleCompleted}
      />
      {error ? (
        <p className="mt-1 px-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <EmailConfirmDialog ref={emailDialogRef} />
    </>
  );
}
