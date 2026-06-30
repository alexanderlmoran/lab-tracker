"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  approvePdf,
  disapproveWrongPdf,
  markAlreadyUploaded,
  retryPdfUpload,
  type PendingPdf,
} from "./pdf-actions";
import { lastNameKey } from "@/lib/labs/patient-name";

export type PdfReviewModalProps = {
  pdf: PendingPdf;
  /** Optional patient label for the modal header. */
  patientName?: string;
  /** Read-only viewer (no approve/disapprove) — used to re-view an already-
   *  uploaded result in the lanes right of Pending Upload. Hides the review
   *  controls, mismatch banners and reference panel; just shows + downloads. */
  readOnly?: boolean;
  onClose: (result: {
    actionTaken: "approved" | "wrong_pdf" | "already_uploaded" | "retry" | "cancel";
  }) => void;
};

type PendingAction = "approve" | "wrong_pdf" | "already_uploaded" | "retry" | null;

// Supabase signed URLs honor a `&download=` param → Content-Disposition
// attachment, so the browser saves the file (cross-origin `download` attrs are
// ignored). The signed URL already carries `?token=`, so append with `&`.
function downloadHref(pdf: PendingPdf): string {
  return `${pdf.signedUrl}&download=${encodeURIComponent(pdf.filename ?? "result.pdf")}`;
}

export function PdfReviewModal({ pdf, patientName, readOnly = false, onClose }: PdfReviewModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  // Wrong-patient override: on a confident last-name mismatch the Approve
  // button is DISABLED until staff type the case patient's name, an explicit
  // "I've verified this really is the right patient" gate (not a one-click
  // bypass). Empty until they choose to override.
  const [overrideText, setOverrideText] = useState("");
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

  // ── Patient-identity comparison — the heart of the wrong-patient guard ──
  // Three states, in priority order:
  //   RED   = the REPORT's patient last-name differs from the case patient.
  //           This is the incident we're preventing (a report for patient A
  //           attached to patient B's case). Approve is DISABLED unless staff
  //           explicitly type the case patient's name to override.
  //   AMBER = names match but the accession differs (the legit stale-accession
  //           case) → a one-click confirm, no name typing required.
  //   GREEN = both match → no banner, normal flow.
  const caseName = pdf.caseRef.patientName ?? "";
  const reportName = pdf.reportPatientName ?? "";
  const reportKey = lastNameKey(reportName);
  const caseKey = lastNameKey(caseName);
  // Only a CONFIDENT mismatch counts (both sides yield a last-name key). A null
  // report name (scraper exposed none) → no banner; the accession tie + the
  // server fail-closed gate are the backstop there.
  const patientMismatch = Boolean(reportKey && caseKey && reportKey !== caseKey);

  const accMismatch = Boolean(
    pdf.externalRef &&
      pdf.caseRef.caseExternalRef &&
      pdf.externalRef !== pdf.caseRef.caseExternalRef,
  );

  // The override is satisfied only when staff retype the CASE patient's name
  // (last-name key match) — a deliberate "I verified this is really them" act.
  const overrideOk = patientMismatch && lastNameKey(overrideText) === caseKey;
  // Approve is blocked while a patient mismatch stands un-overridden.
  const approveBlocked = patientMismatch && !overrideOk;

  function run(action: PendingAction) {
    if (!action || pendingAction) return;
    // Hard stop: never let an Approve fire while a patient mismatch stands
    // un-overridden, even if something re-enabled the button (belt-and-braces
    // beyond the `disabled` attribute).
    if (action === "approve" && approveBlocked) return;
    setPendingAction(action);
    setError(null);
    startTransition(async () => {
      // Stamp the wrong-patient override onto the audit note so the bypass is
      // recorded (who knowingly approved past a mismatch, and the report name).
      const overrideNote =
        action === "approve" && patientMismatch && overrideOk
          ? `OVERRIDE: approved despite patient mismatch (report "${reportName}" vs case "${caseName}")`
          : null;
      const noteValue =
        [notes.trim() || null, overrideNote].filter(Boolean).join(" — ") || undefined;
      const args = { pdfId: pdf.id, caseId: pdf.caseId, notes: noteValue };
      const result =
        action === "approve"
          ? await approvePdf(args)
          : action === "wrong_pdf"
          ? await disapproveWrongPdf(args)
          : action === "already_uploaded"
          ? await markAlreadyUploaded(args)
          : await retryPdfUpload(args);
      if (!result.ok) {
        setError(result.error ?? "Action failed");
        setPendingAction(null);
        return;
      }
      onClose({
        actionTaken:
          action === "approve"
            ? "approved"
            : action === "wrong_pdf"
            ? "wrong_pdf"
            : action === "already_uploaded"
            ? "already_uploaded"
            : "retry",
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
              {readOnly ? "Result PDF" : "Review lab result"}
              {patientName ? ` — ${patientName}` : ""}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{headerSubtitle}</p>
            {!readOnly && pdf.hadUploadFailure && pdf.lastUploadError ? (
              <p className="mt-1 truncate rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[10.5px] text-red-700">
                Last PB upload failed: {pdf.lastUploadError}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={downloadHref(pdf)}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
              title="Download this PDF"
            >
              ⬇ Download
            </a>
            <button
              ref={closeBtnRef}
              type="button"
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              disabled={isPending}
              onClick={() => onClose({ actionTaken: "cancel" })}
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </div>

        {/* ── RED: wrong-patient guard (the incident this screen prevents) ──
         *  The report's patient differs from the case patient. Approve is
         *  disabled; the only way through is to retype the case patient's name
         *  (an explicit "I verified this really is them" override). */}
        {!readOnly && patientMismatch ? (
          <div className="border-b border-red-400 bg-red-100 px-4 py-2.5 text-red-900">
            <div className="flex items-start gap-2 text-[12.5px] font-semibold">
              <span aria-hidden className="text-base leading-none">⚠</span>
              <span>
                PATIENT MISMATCH — this report is for{" "}
                <span className="font-mono">{reportName}</span>, but the case is{" "}
                <span className="font-mono">{caseName}</span>. Do NOT upload — this looks like
                another patient&apos;s result. Disapprove it, or if you have personally verified
                the PDF really is this patient, type{" "}
                <span className="font-mono">{caseName}</span> to override.
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={overrideText}
                onChange={(e) => setOverrideText(e.target.value)}
                placeholder={`Type "${caseName}" to override`}
                className="w-72 rounded-md border border-red-300 bg-white px-2 py-1 text-[12px] text-zinc-900 focus:border-red-500 focus:outline-none"
                disabled={isPending}
                aria-label="Type the case patient name to override the mismatch"
              />
              {overrideOk ? (
                <span className="text-[11px] font-medium text-red-800">
                  Override armed — Approve enabled.
                </span>
              ) : null}
            </div>
          </div>
        ) : !readOnly && accMismatch ? (
          /* ── AMBER: names match but the accession differs (legit stale
           *  accession). Names matching = same patient, so this is a one-click
           *  confirm, not a name-typing gate. Approve stays enabled. */
          <div className="flex items-center gap-2 border-b border-amber-300 bg-amber-100 px-4 py-2 text-[12px] font-semibold text-amber-900">
            <span aria-hidden className="text-base leading-none">⚠</span>
            <span>
              Accession differs (report{" "}
              <span className="font-mono">{pdf.externalRef}</span> vs case{" "}
              <span className="font-mono">{pdf.caseRef.caseExternalRef}</span>) — the patient name
              matches, so this is likely the same person&apos;s newer order. Confirm it&apos;s the
              same patient, then Approve.
            </span>
          </div>
        ) : null}

        {/* ── Body: reference panel + PDF, side by side ─────────────── */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left: what the tracker says this case should be. Hidden in the
           *  read-only viewer — the PDF was already verified at approve time. */}
          {!readOnly ? (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white px-4 py-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Tracker says
            </h3>
            <p className="mt-1 text-[10.5px] text-zinc-500">
              Verify each field appears on the PDF before approving.
            </p>
            <dl className="mt-3 space-y-2 text-[12px]">
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">Patient (case)</dt>
                <dd className="font-medium text-zinc-900">{pdf.caseRef.patientName}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wide text-zinc-500">
                  Patient (report)
                </dt>
                <dd
                  className={`font-medium ${
                    patientMismatch ? "text-red-700" : reportName ? "text-zinc-900" : "text-zinc-400"
                  }`}
                >
                  {reportName || "— not on report —"}
                  {patientMismatch ? (
                    <span className="ml-1 rounded bg-red-100 px-1 text-[10px] font-semibold text-red-800">
                      mismatch
                    </span>
                  ) : reportKey && caseKey ? (
                    <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-800">
                      matches
                    </span>
                  ) : null}
                </dd>
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
          ) : null}

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
        {!readOnly ? (
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
        ) : null}

        {/* ── Action bar — review actions only; hidden in read-only viewer ── */}
        {!readOnly ? (
        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-3">
          <div className="text-[11px] text-zinc-500">
            {error ? (
              <span className="text-red-700">{error}</span>
            ) : approveBlocked ? (
              <span className="font-medium text-red-700">
                Approve is disabled — the report&apos;s patient doesn&apos;t match this case. Disapprove,
                or type the case patient&apos;s name above to override.
              </span>
            ) : (
              "Approve uploads to PracticeBetter. Disapprove skips this result and keeps searching for a newer one."
            )}
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
              className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-[12px] font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
              disabled={isPending}
              onClick={() => run("already_uploaded")}
              title="This result is already on the patient's PB chart — move the card to Complete Uploaded without re-uploading or emailing"
            >
              {pendingAction === "already_uploaded" ? "Marking…" : "Already on PB — complete"}
            </button>
            <button
              type="button"
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isPending || approveBlocked}
              title={
                approveBlocked
                  ? "Patient mismatch — type the case patient's name above to override before approving"
                  : undefined
              }
              onClick={() => run("approve")}
            >
              {pendingAction === "approve" ? "Approving…" : "Approve & upload"}
            </button>
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
