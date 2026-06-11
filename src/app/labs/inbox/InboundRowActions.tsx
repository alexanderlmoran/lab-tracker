"use client";

import { useState, useTransition } from "react";
import {
  applyInboundEmail,
  dismissInboundEmail,
  forwardKkEmailToBodyBio,
  postInboundToPb,
  rematchInboundEmail,
  reparseInboundEmail,
} from "./actions";
import type { LabCase } from "@/lib/types";
import { formatPersonName } from "@/lib/format";

/** Parsed fields the "Create case + Post" path prefills from. */
export type InboundSuggested = {
  patientName?: string | null;
  labName?: string | null;
  collectionDate?: string | null;
  patientDob?: string | null;
  patientEmail?: string | null;
};

export function InboundRowActions({
  inboundId,
  matchedCaseId,
  defaultStep,
  activeCases,
  alreadyApplied,
  dismissOnly = false,
  forwardable = false,
  canReparse = false,
  suggested = null,
}: {
  inboundId: string;
  matchedCaseId: string | null;
  defaultStep: 2 | 4;
  activeCases: Pick<LabCase, "id" | "patient_name" | "lab_name">[];
  alreadyApplied: boolean;
  /** Notification-only rows: only the Dismiss action makes sense. */
  dismissOnly?: boolean;
  /** Kennedy Krieger emails: show "Forward to BodyBio". */
  forwardable?: boolean;
  /** Gmail-ingested rows can re-run extraction + Claude parse + match. */
  canReparse?: boolean;
  /** Claude-parsed fields, for the create-case-and-post path. */
  suggested?: InboundSuggested | null;
}) {
  const [pending, startTransition] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [step, setStep] = useState<2 | 4>(defaultStep);
  const [caseId, setCaseId] = useState<string | null>(matchedCaseId);

  function onForward() {
    startTransition(async () => {
      const r = await forwardKkEmailToBodyBio(inboundId);
      if (!r.ok) alert(r.error);
      else alert(`Forwarded ${r.data?.filename ?? "PDF"} → ${r.data?.to}`);
    });
  }

  const forwardBtn = forwardable ? (
    <button
      type="button"
      onClick={onForward}
      disabled={pending}
      className="rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
      title="Forward this Kennedy Krieger PDF to BodyBio (test address until KK_FORWARD_TO is set)"
    >
      Forward to BodyBio
    </button>
  ) : null;

  function onApply() {
    if (!caseId) {
      alert("Pick a case first.");
      return;
    }
    startTransition(async () => {
      const r = await applyInboundEmail({ inboundId, caseId, step });
      if (!r.ok) alert(r.error);
    });
  }

  function onReparse() {
    startTransition(async () => {
      const r = await reparseInboundEmail({ inboundId });
      if (!r.ok) alert(r.error);
    });
  }

  function onPostToPb() {
    if (!caseId) {
      alert("Pick a case first (or use Create case + Post).");
      return;
    }
    const target = activeCases.find((c) => c.id === caseId);
    if (
      !confirm(
        `Post this email's PDF as the RESULT on ${target ? `${formatPersonName(target.patient_name)} · ${target.lab_name}` : "the selected case"}?\n\nIt stages auto-approved and uploads to PracticeBetter.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await postInboundToPb({ inboundId, caseId });
      if (!r.ok) alert(r.error);
    });
  }

  function onCreateAndPost() {
    if (!suggested?.patientName || !suggested?.labName) return;
    if (
      !confirm(
        `Create a new case and post this PDF to PracticeBetter?\n\nPatient: ${formatPersonName(suggested.patientName)}\nLab: ${suggested.labName}\nCollection date: ${suggested.collectionDate ?? "(none parsed)"}`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await postInboundToPb({
        inboundId,
        createCase: {
          patientName: suggested.patientName!,
          labName: suggested.labName!,
          collectionDate: suggested.collectionDate ?? null,
          patientDob: suggested.patientDob ?? null,
          patientEmail: suggested.patientEmail ?? null,
        },
      });
      if (!r.ok) alert(r.error);
    });
  }

  const reparseBtn = canReparse ? (
    <button
      type="button"
      onClick={onReparse}
      disabled={pending}
      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      title="Re-run PDF extraction + Claude parse + case match for this email"
    >
      {pending ? "Working…" : "Re-parse"}
    </button>
  ) : null;

  function onDismiss() {
    if (!confirm("Dismiss this report? It stays in the audit log.")) return;
    startTransition(async () => {
      const r = await dismissInboundEmail({ inboundId });
      if (!r.ok) alert(r.error);
    });
  }

  function onRematch(newId: string) {
    setCaseId(newId);
    setPickerOpen(false);
    startTransition(async () => {
      const r = await rematchInboundEmail({ inboundId, caseId: newId });
      if (!r.ok) alert(r.error);
    });
  }

  if (alreadyApplied) {
    return (
      <span className="text-xs text-emerald-700">Applied — case advanced.</span>
    );
  }

  if (dismissOnly) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {forwardBtn}
        {reparseBtn}
        <button
          type="button"
          onClick={onDismiss}
          disabled={pending}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {forwardBtn}
      {reparseBtn}
      <select
        value={step}
        onChange={(e) => setStep(Number(e.target.value) as 2 | 4)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
      >
        <option value={4}>Mark step 4 (complete received)</option>
        <option value={2}>Mark step 2 (partial received)</option>
      </select>
      {pickerOpen ? (
        <select
          value={caseId ?? ""}
          onChange={(e) => onRematch(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
        >
          <option value="">— Pick a case —</option>
          {activeCases.map((c) => (
            <option key={c.id} value={c.id}>
              {formatPersonName(c.patient_name)} · {c.lab_name}
            </option>
          ))}
        </select>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          Change case
        </button>
      )}
      <button
        type="button"
        onClick={onApply}
        disabled={pending || !caseId}
        title="Only tick the step on the case — does NOT upload the PDF"
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        Mark step only
      </button>
      {caseId ? (
        <button
          type="button"
          onClick={onPostToPb}
          disabled={pending}
          title="Stage this email's PDF as the case result — auto-approved → PracticeBetter"
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Posting…" : "Post to PB"}
        </button>
      ) : suggested?.patientName && suggested?.labName ? (
        <button
          type="button"
          onClick={onCreateAndPost}
          disabled={pending}
          title={`Create a ${suggested.labName} case for ${suggested.patientName}${suggested.collectionDate ? ` (collected ${suggested.collectionDate})` : ""} and post the PDF to PracticeBetter`}
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Posting…" : "Create case + Post to PB"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        Dismiss
      </button>
    </div>
  );
}
