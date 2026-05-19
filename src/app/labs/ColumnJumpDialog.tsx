"use client";

import { forwardRef, useImperativeHandle, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import type { ColumnKey } from "@/lib/columns";
import { COLUMN_LABEL } from "@/lib/columns";
import { planColumnJump, type StepPlan } from "@/lib/column-jump";
import { stepLabel } from "@/lib/columns";
import { setStepCompleted } from "./actions";
import { skipPatientEmail } from "./email-actions";
import { formatPersonName } from "@/lib/format";
import type { EmailConfirmHandle } from "./EmailConfirmDialog";

export type ColumnJumpHandle = {
  open: (args: {
    row: LabCase;
    target: ColumnKey;
    emailDialog: EmailConfirmHandle;
  }) => Promise<{ moved: boolean; cancelled: boolean }>;
};

type Resolver = (value: { moved: boolean; cancelled: boolean }) => void;

export const ColumnJumpDialog = forwardRef<ColumnJumpHandle>(function ColumnJumpDialog(_, ref) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [state, setState] = useState<{
    row: LabCase;
    target: ColumnKey;
    plans: StepPlan[];
    error: string | null;
    emailDialog: EmailConfirmHandle;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const resolverRef = useRef<Resolver | null>(null);

  useImperativeHandle(ref, () => ({
    open: ({ row, target, emailDialog }) =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        const plans = planColumnJump(row, target).filter((p) => !p.alreadyComplete);
        if (plans.length === 0) {
          // Already in target column — nothing to do.
          resolve({ moved: false, cancelled: false });
          return;
        }
        setState({ row, target, plans, error: null, emailDialog });
        dialogRef.current?.showModal();
      }),
  }));

  function settle(result: { moved: boolean; cancelled: boolean }) {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
    dialogRef.current?.close();
  }

  function onCancel() {
    settle({ moved: false, cancelled: true });
  }

  async function executePlans(plans: StepPlan[], skipEmails: boolean) {
    if (!state) return;
    for (const p of plans) {
      if (p.isEmailStep && p.emailKind) {
        if (skipEmails) {
          const res = await skipPatientEmail({
            caseId: state.row.id,
            kind: p.emailKind,
          });
          if (!res.ok) {
            setState((s) => (s ? { ...s, error: res.error } : s));
            return;
          }
        } else {
          // Hand off to the email confirm dialog. Cancelling rolls back the
          // entire move — partial-success would be confusing.
          const r = await state.emailDialog.open({
            caseId: state.row.id,
            kind: p.emailKind,
          });
          if (r.cancelled) {
            settle({ moved: false, cancelled: true });
            return;
          }
        }
      } else {
        const res = await setStepCompleted({
          caseId: state.row.id,
          step: p.step,
          completed: true,
        });
        if (!res.ok) {
          setState((s) => (s ? { ...s, error: res.error } : s));
          return;
        }
      }
    }
    settle({ moved: true, cancelled: false });
  }

  function onSendAll() {
    startTransition(() => {
      void executePlans(state?.plans ?? [], false);
    });
  }

  function onMoveSkipEmails() {
    startTransition(() => {
      void executePlans(state?.plans ?? [], true);
    });
  }

  if (!state) {
    return (
      <dialog
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      />
    );
  }

  const emailSteps = state.plans.filter((p) => p.isEmailStep);

  return (
    <dialog
      ref={dialogRef}
      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
    >
      <div className="flex flex-col">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            Move {formatPersonName(state.row.patient_name)} to &ldquo;{COLUMN_LABEL[state.target]}&rdquo;?
          </h2>
        </div>

        <div className="px-6 py-4 text-sm">
          <p className="text-zinc-700">
            This will mark {state.plans.length === 1 ? "step" : "steps"}{" "}
            <strong>
              {state.plans.map((p) => p.step).join(", ")}
            </strong>{" "}
            complete:
          </p>
          <ul className="mt-2 space-y-1 text-xs text-zinc-600">
            {state.plans.map((p) => (
              <li key={p.step} className="flex items-center gap-2">
                <span>·</span>
                <span>
                  Step {p.step}: {stepLabel(p.step)}
                </span>
                {p.isEmailStep ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                    email confirm
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {emailSteps.length > 0 ? (
            <p className="mt-3 text-xs text-zinc-500">
              You&apos;ll review and confirm each email individually before
              anything is sent. Cancelling any one rolls back the entire move.
            </p>
          ) : null}

          {state.error ? (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-200 px-6 py-3">
          <button
            type="button"
            onClick={onSendAll}
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            {emailSteps.length > 0
              ? `Review and send ${emailSteps.length} email${emailSteps.length === 1 ? "" : "s"} →`
              : "Move"}
          </button>
          {emailSteps.length > 0 ? (
            <button
              type="button"
              onClick={onMoveSkipEmails}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Move without sending emails
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
});
