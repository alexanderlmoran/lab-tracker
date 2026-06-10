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

export function StepChecklist({
  initial,
  siblingCount = 0,
}: {
  initial: LabCase;
  /** Number of same-accession sibling cards (one physical order split across
   *  cards), excluding this one. When >0, staff can opt to move the whole
   *  group together so a step toggle doesn't orphan a sibling. */
  siblingCount?: number;
}) {
  const [c, setC] = useState<LabCase>(initial);
  const [pendingStep, setPendingStep] = useState<StepNumber | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Default ON: same-accession siblings are one order, so the common intent is
  // to move them together (backlog #3 — moving one card left the others behind).
  const [moveSiblings, setMoveSiblings] = useState(true);
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
        // Move the whole same-order group together when staff opted in (and
        // there's actually a sibling to move). The board revalidates so the
        // siblings reflect the new column without a manual reopen.
        cascadeSiblings: moveSiblings && siblingCount > 0,
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

  // Derived/terminal stages that bracket the numbered steps so the card's ladder
  // matches the board columns: Ready to ship (auto on tracking #, before step 1)
  // → 1–9 → Completed (archived). These are deliberately NOT checkboxes — a
  // status DOT + italic label + tag, so they read as state, not tickable steps.
  // "Ready to ship" is read-only (`auto` — happens when a tracking # is added);
  // "Completed" is a clickable row that archives/unarchives (`stage`).
  function StageRow({
    label,
    hint,
    checked,
    tone,
    pending,
    onChange,
  }: {
    label: string;
    hint?: string;
    checked: boolean;
    tone: "ready" | "done";
    pending?: boolean;
    onChange?: (next: boolean) => void;
  }) {
    const interactive = Boolean(onChange);
    const dot = checked
      ? tone === "ready"
        ? "border-orange-400 bg-orange-400"
        : "border-emerald-500 bg-emerald-500"
      : "border-zinc-300 bg-transparent";
    const inner = (
      <>
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full border ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] italic text-zinc-500" title={label}>
          {label}
          {hint ? <span className="not-italic text-zinc-400"> — {hint}</span> : null}
        </span>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-400">
          {interactive ? "stage" : "auto"}
        </span>
      </>
    );
    const cls = "flex w-full items-center gap-2 rounded-md bg-zinc-50/70 px-1.5 py-1 text-left";
    return interactive ? (
      <button
        type="button"
        onClick={() => onChange?.(!checked)}
        disabled={pending}
        className={`${cls} hover:bg-zinc-100 disabled:opacity-60`}
        title={checked ? "Archived — click to restore to the board" : "Archive this case to the Completed lane"}
      >
        {inner}
      </button>
    ) : (
      <div className={cls}>{inner}</div>
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
          tone="ready"
          label="Ready to ship"
          hint={c.tracking_number ? "tracking # attached, waiting for carrier" : "add a tracking # to reach this"}
          checked={Boolean(c.tracking_number)}
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
      {siblingCount > 0 ? (
        <label className="mt-1 flex items-center gap-2 px-2 text-[11px] text-purple-800">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-purple-300"
            checked={moveSiblings}
            onChange={(e) => setMoveSiblings(e.target.checked)}
          />
          Move all {siblingCount + 1} same-order cards together
        </label>
      ) : null}
      <StageRow
        tone="done"
        label="Completed"
        hint={c.archived_at ? "archived — click to restore" : "click to archive to the Completed lane"}
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
