"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { EmailKind, LabCase, StepNumber } from "@/lib/types";
import {
  getCaseWorkflow,
  getWorkflowSteps,
  isEmailStep,
  stepIsComplete,
  stepLabelForWorkflow,
} from "@/lib/columns";
import { emailKindForStep } from "@/lib/email/step-map";
import { archiveLabCase, setStepCompleted, setWithPatient, unarchiveLabCase } from "./actions";
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
  moveSiblings = true,
}: {
  initial: LabCase;
  /** Number of same-accession sibling cards (one physical order split across
   *  cards), excluding this one. When >0, staff can opt to move the whole
   *  group together so a step toggle doesn't orphan a sibling. */
  siblingCount?: number;
  /** Whether step toggles cascade across same-order siblings. Owned by
   *  CaseDetail now — the checkbox moved into the Same-order panel. */
  moveSiblings?: boolean;
}) {
  const [c, setC] = useState<LabCase>(initial);
  const [pendingStep, setPendingStep] = useState<StepNumber | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [wpPending, setWpPending] = useState(false);
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

  // Staff "Given to patient" — sets the with_patient_at timestamp so the card
  // moves to the "With Patient" lane (until the sample is sent). Not a numbered
  // step; a derived stage row in the ladder, like Ready to Ship / Completed.
  function onToggleWithPatient(next: boolean) {
    setError(null);
    setWpPending(true);
    const prevSnapshot = c;
    setC((prev) => ({ ...prev, with_patient_at: next ? new Date().toISOString() : null }) as LabCase);
    startTransition(async () => {
      const res = await setWithPatient(c.id, next);
      setWpPending(false);
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
  // Compact rung for the 3 owner columns: checkbox + label on one tight line,
  // and the hint (when present) on its OWN line below — small + muted — so a
  // long hint ("tap when with the patient") never truncates into "tap…".
  function StageRow({
    label,
    hint,
    checked,
    pending,
    onChange,
  }: {
    label: string;
    hint?: string;
    checked: boolean;
    pending?: boolean;
    /** Provided → an interactive step (Completed toggles archive). Omitted →
     *  read-only "auto" stage (Ready to ship, derived from the tracking #). */
    onChange?: (next: boolean) => void;
  }) {
    const interactive = Boolean(onChange);
    return (
      <div className="rounded-md px-1 py-1 hover:bg-zinc-50">
        <label className={`flex min-w-0 items-center gap-1.5 ${interactive ? "cursor-pointer" : ""}`}>
          <input
            type="checkbox"
            className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300"
            checked={checked}
            disabled={!interactive || pending}
            onChange={(e) => onChange?.(e.target.checked)}
          />
          <span
            className={`min-w-0 flex-1 truncate text-[11px] text-zinc-900 ${
              checked ? "line-through decoration-zinc-400" : ""
            }`}
            title={label}
          >
            {label}
          </span>
        </label>
        {hint ? (
          <span className="ml-5 block text-[10px] leading-tight text-zinc-500">{hint}</span>
        ) : null}
      </div>
    );
  }

  // A single step rung (checkbox + label + optional Send-email button). Shared
  // by the owner columns (default) and the peptides fallback.
  function StepRow({ step, label, hint }: { step: StepNumber; label: string; hint?: string }) {
    const checked = stepIsComplete(c, step);
    // Step 4 isn't normally an email step, but in peptides it stands in for
    // "package received" — closure, no email. Only step 1 emails there.
    const isEmail = isEmailStep(step) && (workflow !== "peptides" || step === 1);
    const isPending = pendingStep === step;
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
      <div className="rounded-md px-1 py-1 hover:bg-zinc-50">
        <div className="flex items-center gap-1.5">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300"
              checked={checked}
              disabled={isPending}
              onChange={(e) => onToggle(step, e.target.checked)}
            />
            <span
              className={`min-w-0 flex-1 truncate text-[11px] text-zinc-900 ${
                checked ? "line-through decoration-zinc-400" : ""
              }`}
              title={label}
            >
              {label}
            </span>
          </label>
          {isEmail ? (
            <button
              type="button"
              onClick={() => void onSendEmail(step)}
              disabled={isPending}
              className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              title={tooltip}
            >
              {hasSent ? "Resend" : "Send"}
            </button>
          ) : null}
        </div>
        {hint ? (
          <span className="ml-5 block text-[10px] leading-tight text-zinc-500">{hint}</span>
        ) : null}
      </div>
    );
  }

  // Default workflow: lay the lanes out in the SAME three owner columns as the
  // board (Alex · Catherine/Nadia · Allison), each rung = a board lane, so the
  // checklist mirrors the kanban exactly. Tints match the board's owner banner.
  const ownerColumns: { owner: string; tint: string; rows: ReactNode[] }[] = [
    {
      owner: "Alex",
      tint: "border-sky-200 bg-sky-100 text-sky-800",
      rows: [
        <StageRow
          key="rts"
          label="Ready to Ship"
          hint={c.tracking_number ? "tracking # attached" : "add a tracking #"}
          checked={Boolean(c.tracking_number)}
        />,
        <StageRow
          key="wp"
          label="With Patient"
          hint={c.with_patient_at ? "given to patient" : "tap when with the patient"}
          checked={Boolean(c.with_patient_at)}
          pending={wpPending}
          onChange={onToggleWithPatient}
        />,
        <StepRow key="s1" step={1} label="Sample Sent" />,
      ],
    },
    {
      owner: "Catherine / Nadia",
      tint: "border-amber-200 bg-amber-100 text-amber-800",
      rows: [
        <StepRow key="s4" step={4} label="Pending Upload" />,
        <StepRow key="s5" step={5} label="Upload Complete" />,
      ],
    },
    {
      owner: "Allison",
      tint: "border-violet-200 bg-violet-100 text-violet-800",
      rows: [
        <StepRow key="s6" step={6} label="ROF Scheduled" />,
        <StepRow key="s7" step={7} label="ROF Done" />,
        <StepRow key="s8" step={8} label="Protocol received" />,
        <StageRow
          key="done"
          label="Completed"
          hint={c.archived_at ? "archived — click to restore" : "archive"}
          checked={Boolean(c.archived_at)}
          pending={archiving}
          onChange={onToggleCompleted}
        />,
      ],
    },
  ];

  return (
    <>
      {workflow === "peptides" ? (
        // Peptides: shipped → received, no owner split.
        <div className="flex max-w-sm flex-col">
          {stepsToShow.map((step, i) => (
            <StepRow
              key={step}
              step={step}
              label={`${i + 1}. ${stepLabelForWorkflow(workflow, step)}`}
            />
          ))}
          <StageRow
            label="Completed"
            hint={c.archived_at ? "archived — click to restore" : "archive"}
            checked={Boolean(c.archived_at)}
            pending={archiving}
            onChange={onToggleCompleted}
          />
        </div>
      ) : (
        // Three owner columns mirroring the board lanes (Alex · Catherine/Nadia ·
        // Allison). Tight gaps maximise per-column width; compact rungs (small
        // font, hint-on-own-line, shrunk Send buttons) keep text from clipping.
        <div className="grid gap-x-2 gap-y-2 sm:grid-cols-3">
          {ownerColumns.map((g) => (
            <div key={g.owner} className="flex min-w-0 flex-col">
              <div
                className={`mb-2.5 rounded-md border px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide ${g.tint}`}
              >
                {g.owner}
              </div>
              <div className="flex flex-col gap-y-0.5">{g.rows}</div>
            </div>
          ))}
        </div>
      )}
      {error ? (
        <p className="mt-1 px-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <EmailConfirmDialog ref={emailDialogRef} />
    </>
  );
}
