"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useTransition } from "react";
import type { PatientEmailKind } from "@/lib/email/template-data";
import { sendPatientEmail, skipPatientEmail, resendPatientEmail } from "./email-actions";
import { getEmailMeta, type EmailMeta } from "./email-meta-action";

export type EmailConfirmHandle = {
  open: (args: { caseId: string; kind: PatientEmailKind }) => Promise<{
    sent: boolean;
    skipped: boolean;
    cancelled: boolean;
    resent?: boolean;
  }>;
};

type Resolver = (value: {
  sent: boolean;
  skipped: boolean;
  cancelled: boolean;
  resent?: boolean;
}) => void;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const EmailConfirmDialog = forwardRef<EmailConfirmHandle>(function EmailConfirmDialog(_, ref) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [state, setState] = useState<{
    caseId: string;
    kind: PatientEmailKind;
    meta: EmailMeta | null;
    error: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const resolverRef = useRef<Resolver | null>(null);

  useImperativeHandle(ref, () => ({
    open: ({ caseId, kind }) =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        setState({ caseId, kind, meta: null, error: null });
        dialogRef.current?.showModal();
        getEmailMeta({ caseId, kind }).then((res) => {
          if (res.ok) {
            setState((s) => (s ? { ...s, meta: res.data } : s));
          } else {
            setState((s) => (s ? { ...s, error: res.error } : s));
          }
        });
      }),
  }));

  function settle(result: { sent: boolean; skipped: boolean; cancelled: boolean; resent?: boolean }) {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
    dialogRef.current?.close();
  }

  function onCancel() {
    settle({ sent: false, skipped: false, cancelled: true });
  }

  function onSend() {
    if (!state) return;
    startTransition(async () => {
      const res = await sendPatientEmail({ caseId: state.caseId, kind: state.kind });
      if (!res.ok) {
        setState((s) => (s ? { ...s, error: res.error } : s));
        return;
      }
      settle({ sent: true, skipped: false, cancelled: false });
    });
  }

  function onSkip() {
    if (!state) return;
    startTransition(async () => {
      const res = await skipPatientEmail({ caseId: state.caseId, kind: state.kind });
      if (!res.ok) {
        setState((s) => (s ? { ...s, error: res.error } : s));
        return;
      }
      settle({ sent: false, skipped: true, cancelled: false });
    });
  }

  function onResend() {
    if (!state) return;
    startTransition(async () => {
      const res = await resendPatientEmail({ caseId: state.caseId, kind: state.kind });
      if (!res.ok) {
        setState((s) => (s ? { ...s, error: res.error } : s));
        return;
      }
      settle({ sent: true, skipped: false, cancelled: false, resent: true });
    });
  }

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handler = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    dlg.addEventListener("cancel", handler);
    return () => dlg.removeEventListener("cancel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewSrc =
    state && state.meta
      ? `/api/email/preview?caseId=${state.caseId}&kind=${state.kind}`
      : null;
  const isResendMode = Boolean(state?.meta?.priorSend);

  return (
    <dialog
      ref={dialogRef}
      className="w-full max-w-2xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
    >
      <div className="flex max-h-[90dvh] flex-col">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              {isResendMode ? "Resend patient email?" : "Send patient email?"}
            </h2>
            <p className="text-xs text-zinc-500">
              {isResendMode
                ? "This patient already received this email. Re-sending creates a new entry in the audit log."
                : "Once sent, this cannot be unsent. The audit log records every send."}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            aria-label="Close"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          {state?.meta?.priorSend ? (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <strong>Already {state.meta.priorSend.status === "skipped" ? "skipped" : "sent"}</strong>
              {" — "}
              <span>
                last on{" "}
                <span className="font-medium">
                  {formatTimestamp(state.meta.priorSend.createdAt)}
                </span>
                {state.meta.priorSend.totalSentCount > 1
                  ? ` (${state.meta.priorSend.totalSentCount} sends total)`
                  : null}
                .
              </span>
              {state.meta.priorSend.status === "sent" ? (
                <span> Click <strong>Send again</strong> to dispatch a new copy.</span>
              ) : (
                <span> Click <strong>Send now</strong> to dispatch the email anyway.</span>
              )}
            </div>
          ) : null}

          {state?.meta?.isTestRedirect ? (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <strong>Test mode</strong> — sending to{" "}
              <code>{state.meta.to}</code>. Real recipient (
              <code>{state.meta.testRedirectTarget}</code>) will not receive
              anything. Subject prefixed with <code>[TEST → original]</code>.
            </div>
          ) : null}

          {state?.meta ? (
            <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">To</dt>
              <dd className="text-zinc-900">{state.meta.to}</dd>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">From</dt>
              <dd className="text-zinc-900">{state.meta.from}</dd>
              {state.meta.replyTo ? (
                <>
                  <dt className="text-xs uppercase tracking-wide text-zinc-500">
                    Reply-To
                  </dt>
                  <dd className="text-zinc-900">{state.meta.replyTo}</dd>
                </>
              ) : null}
              {state.meta.bcc.length ? (
                <>
                  <dt className="text-xs uppercase tracking-wide text-zinc-500">BCC</dt>
                  <dd className="text-zinc-900">{state.meta.bcc.join(", ")}</dd>
                </>
              ) : null}
              <dt className="text-xs uppercase tracking-wide text-zinc-500">
                Subject
              </dt>
              <dd className="text-zinc-900">{state.meta.subject}</dd>
            </dl>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}

          {previewSrc ? (
            <div className="mt-4 overflow-hidden rounded-md border border-zinc-200">
              <iframe
                src={previewSrc}
                title="Email preview"
                sandbox=""
                className="h-[420px] w-full bg-white"
              />
            </div>
          ) : null}

          {state?.error ? (
            <p className="mt-4 text-sm text-red-600" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-6 py-3">
          {isResendMode ? (
            <span className="text-xs text-zinc-500">Step is already complete.</span>
          ) : (
            <button
              type="button"
              onClick={onSkip}
              disabled={pending || !state?.meta}
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline disabled:opacity-50"
            >
              Mark step complete without sending
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            {isResendMode ? (
              <button
                type="button"
                onClick={onResend}
                disabled={pending || !state?.meta}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
              >
                {pending ? "Sending…" : "Send again"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={pending || !state?.meta}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
              >
                {pending ? "Sending…" : "Send and mark step complete"}
              </button>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
});
