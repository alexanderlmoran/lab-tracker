"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  approvePdf,
  disapproveWrongPdf,
  retryPdfUpload,
  type PendingPdf,
} from "./pdf-actions";

export type PdfReviewModalProps = {
  pdf: PendingPdf;
  /** Optional patient label for the modal header. */
  patientName?: string;
  onClose: (result: { actionTaken: "approved" | "wrong_pdf" | "retry" | "cancel" }) => void;
};

type PendingAction = "approve" | "wrong_pdf" | "retry" | null;

export function PdfReviewModal({ pdf, patientName, onClose }: PdfReviewModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [isPending, startTransition] = useTransition();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) onClose({ actionTaken: "cancel" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPending, onClose]);

  function run(action: PendingAction) {
    if (!action || pendingAction) return;
    setPendingAction(action);
    setError(null);
    startTransition(async () => {
      const noteValue = notes.trim() || undefined;
      const args = { pdfId: pdf.id, caseId: pdf.caseId, notes: noteValue };
      const result =
        action === "approve"
          ? await approvePdf(args)
          : action === "wrong_pdf"
          ? await disapproveWrongPdf(args)
          : await retryPdfUpload(args);
      if (!result.ok) {
        setError(result.error ?? "Action failed");
        setPendingAction(null);
        return;
      }
      onClose({
        actionTaken:
          action === "approve" ? "approved" : action === "wrong_pdf" ? "wrong_pdf" : "retry",
      });
    });
  }

  const headerSubtitle = [
    pdf.externalRef ? `Acc# ${pdf.externalRef}` : null,
    pdf.isPartial ? "Partial result" : "Complete result",
    pdf.resultIssuedAt ? `Issued ${pdf.resultIssuedAt.slice(0, 10)}` : null,
    `Attached by ${pdf.attachedBy}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Review lab PDF"
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-900">
              Review lab result{patientName ? ` — ${patientName}` : ""}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{headerSubtitle}</p>
            {pdf.hadUploadFailure && pdf.lastUploadError ? (
              <p className="mt-1 truncate rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[10.5px] text-red-700">
                Last PB upload failed: {pdf.lastUploadError}
              </p>
            ) : null}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            disabled={isPending}
            onClick={() => onClose({ actionTaken: "cancel" })}
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {/* ── Body: reference panel + PDF, side by side ─────────────── */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left: what the tracker says this case should be. */}
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white px-4 py-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Tracker says
            </h3>
            <p className="mt-1 text-[10.5px] text-zinc-500">
              Verify each field appears on the PDF before approving.
            </p>
            <dl className="mt-3 space-y-2 text-[12px]">
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">Patient</dt>
                <dd className="font-medium text-zinc-900">{pdf.caseRef.patientName}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">DOB</dt>
                <dd className="font-mono text-zinc-900">
                  {pdf.caseRef.patientDob ?? <span className="text-zinc-400">— not set —</span>}
                </dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">Lab</dt>
                <dd className="text-zinc-900">{pdf.caseRef.labName}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">Accession #</dt>
                <dd className="font-mono text-zinc-900">
                  {pdf.caseRef.caseExternalRef ?? <span className="text-zinc-400">— not set —</span>}
                  {pdf.externalRef && pdf.caseRef.caseExternalRef &&
                  pdf.externalRef !== pdf.caseRef.caseExternalRef ? (
                    <span
                      className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800"
                      title={`PDF reports accession ${pdf.externalRef}`}
                    >
                      mismatch
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">Collection date</dt>
                <dd className="font-mono text-zinc-900">
                  {pdf.caseRef.collectionDate ?? <span className="text-zinc-400">— not set —</span>}
                </dd>
              </div>
            </dl>
            <hr className="my-3 border-zinc-200" />
            <h4 className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
              PDF metadata
            </h4>
            <dl className="mt-2 space-y-1 text-[11px] text-zinc-700">
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">File</dt>
                <dd className="truncate font-mono" title={pdf.filename ?? ""}>{pdf.filename ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Source</dt>
                <dd className="truncate">{pdf.attachedBy}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Attached</dt>
                <dd className="font-mono">{pdf.attachedAt.slice(0, 16).replace("T", " ")}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Result</dt>
                <dd>{pdf.isPartial ? "Partial" : "Complete"}</dd>
              </div>
            </dl>
          </aside>

          {/* Right: the PDF itself. */}
          <div className="flex-1 overflow-hidden bg-zinc-100">
            <iframe
              src={pdf.signedUrl}
              title="Lab PDF"
              className="h-full w-full border-0"
            />
          </div>
        </div>

        {/* ── Optional notes field ────────────────────────────────── */}
        <div className="border-t border-zinc-200 bg-white px-4 py-2">
          {notesOpen ? (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional note (saved to audit log)"
              rows={2}
              maxLength={500}
              className="w-full rounded-md border border-zinc-300 px-2 py-1 text-[12px] text-zinc-800 focus:border-zinc-500 focus:outline-none"
              disabled={isPending}
            />
          ) : (
            <button
              type="button"
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline"
              onClick={() => setNotesOpen(true)}
            >
              + Add note (optional)
            </button>
          )}
        </div>

        {/* ── Action bar ───────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-3">
          <div className="text-[11px] text-zinc-500">
            {error ? <span className="text-red-700">{error}</span> : "Approve uploads to PracticeBetter. Disapprove skips this result and keeps searching for a newer one."}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              disabled={isPending}
              onClick={() => run("wrong_pdf")}
              title="This isn't the right result — skip this accession and keep searching the portal for a newer one"
            >
              {pendingAction === "wrong_pdf" ? "Marking…" : "Disapprove — keep searching"}
            </button>
            {pdf.hadUploadFailure ? (
              <button
                type="button"
                className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                disabled={isPending}
                onClick={() => run("retry")}
              >
                {pendingAction === "retry" ? "Queuing…" : "Retry upload"}
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              disabled={isPending}
              onClick={() => run("approve")}
            >
              {pendingAction === "approve" ? "Approving…" : "Approve & upload"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
