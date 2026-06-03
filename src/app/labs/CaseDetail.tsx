"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  completedStepCount,
  getCaseWorkflow,
  getColumnFor,
  getWorkflowSteps,
} from "@/lib/columns";
import { StepChecklist } from "./StepChecklist";
import { ActivityLog } from "./ActivityLog";
import { EmailLogPanel } from "./EmailLogPanel";
import { BarcodeScanner } from "./BarcodeScanner";
import { CaseDialog } from "./CaseDialog";
import { PdfReviewModal } from "./PdfReviewModal";
import { getPendingPdfForCase, type PendingPdf } from "./pdf-actions";
import { LabPortalLinks } from "./LabPortalLinks";
import { FindResultButton } from "./FindResultButton";
import { ManageLabsButton } from "./PatientLabManager";
import { RefreshLabStatusButton } from "./RefreshLabStatusButton";
import { RefreshTrackingButton } from "./RefreshTrackingButton";
import {
  archiveLabCase,
  attachTrackingFromScan,
  deleteLabCase,
  markCaseClosed,
  unarchiveLabCase,
} from "./actions";
import {
  getDrawNote,
  markPatientReached,
  recordContactAttempt,
  updateDrawNote,
} from "./draw-actions";
import { useRouter } from "next/navigation";
import { getLabDestination, trackingDestinationWarning } from "@/lib/labs/catalog";
import { labelForCase } from "@/lib/labs/label";

function DeleteCaseButton({ caseId }: { caseId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  function onClick() {
    if (
      !confirm(
        "Delete this case?\n\nIt's a soft delete — the row moves to Settings → Deleted where you can restore it. Patient emails sent so far stay logged.",
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const r = await deleteLabCase(caseId);
      if (!r.ok) {
        setError(r.error ?? "Failed to delete");
        return;
      }
      router.refresh();
    });
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        title="Soft-delete this case (recoverable from Settings → Deleted)"
      >
        {pending ? "Deleting…" : "Delete case"}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

function ArchiveCaseButton({
  caseId,
  isArchived,
}: {
  caseId: string;
  isArchived: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  function onClick() {
    const msg = isArchived
      ? "Unarchive this case?\n\nIt will return to the active lanes."
      : "Archive this case?\n\nIt moves to the Completed lane and stops appearing in Stale/Likely-ready filters. You can unarchive it any time.";
    if (!confirm(msg)) return;
    setError(null);
    start(async () => {
      const r = isArchived
        ? await unarchiveLabCase(caseId)
        : await archiveLabCase(caseId);
      if (!r.ok) {
        setError(r.error ?? "Failed");
        return;
      }
      router.refresh();
    });
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        title={
          isArchived
            ? "Move back to active lanes"
            : "Move to Completed lane (keeps the case but hides it from active filters)"
        }
      >
        {pending
          ? isArchived
            ? "Unarchiving…"
            : "Archiving…"
          : isArchived
            ? "Unarchive"
            : "Archive"}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

function MarkClosedButton({
  caseId,
  isAlreadyClosed,
  isPeptides,
}: {
  caseId: string;
  isAlreadyClosed: boolean;
  isPeptides: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirmText = isPeptides
    ? "Mark this peptides order as received?\n\nTicks both shipping and receipt steps so the card lands in the Received column. No patient emails fire — use this for orders the patient has already confirmed.\n\nReversible: untick any step to undo."
    : "Mark this case as closed?\n\nSets every applicable step to done and lands the card in the Closed column. No patient emails fire — use this for cases that are historically complete.\n\nReversible: untick any step in the checklist to undo.";
  const doneLabel = isPeptides ? "Received" : "Protocol received";
  const actionLabel = isPeptides ? "Mark as received →" : "Mark protocol received →";

  function onClick() {
    if (!confirm(confirmText)) return;
    setError(null);
    start(async () => {
      const r = await markCaseClosed(caseId);
      if (!r.ok) setError(r.error ?? "Failed");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || isAlreadyClosed}
        title={
          isAlreadyClosed
            ? `${doneLabel} already`
            : isPeptides
              ? "Mark the peptides order as received without firing emails"
              : "Bulk-advance to Protocol received without firing emails"
        }
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Saving…" : isAlreadyClosed ? doneLabel : actionLabel}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

/**
 * Records a Nadia-style contact attempt against the case. The button opens
 * a dropdown of common sales-style reasons (no answer, VM left, etc) — the
 * chosen label becomes the event note. "Other…" falls back to free text.
 * Open-attempt count is tracked locally so the parent card tint can react
 * without waiting for a router refresh.
 */
const CONTACT_REASONS: string[] = [
  "No answer",
  "Voicemail left",
  "Texted — no reply",
  "Emailed — no reply",
  "Wrong number",
  "Asked to call back later",
];

function ContactAttemptButton({
  caseId,
  openAttempts,
  onAttempt,
}: {
  caseId: string;
  openAttempts: number;
  onAttempt: (next: number) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  // Close on outside click — the dropdown is a plain absolute div, not a
  // <dialog>, so we wire dismissal ourselves.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  function record(reason: string) {
    setMenuOpen(false);
    setError(null);
    start(async () => {
      const r = await recordContactAttempt({ caseId, note: reason });
      if (!r.ok) {
        const msg = r.error ?? "Failed to record contact attempt";
        setError(msg);
        // Loud alert — the tiny inline error was easy to miss and made
        // it look like the action silently failed.
        alert(`Contact attempt failed:\n\n${msg}`);
        return;
      }
      onAttempt(r.data?.openAttempts ?? openAttempts + 1);
      // revalidatePath fires server-side; this ensures the kanban behind
      // the open modal also re-renders so the 📞 chip appears immediately.
      router.refresh();
    });
  }

  function recordOther() {
    setMenuOpen(false);
    const note = window.prompt("Reason / note for this contact attempt:", "");
    if (note === null) return;
    const trimmed = note.trim();
    if (!trimmed) return;
    setError(null);
    start(async () => {
      const r = await recordContactAttempt({ caseId, note: trimmed });
      if (!r.ok) {
        const msg = r.error ?? "Failed to record contact attempt";
        setError(msg);
        alert(`Contact attempt failed:\n\n${msg}`);
        return;
      }
      onAttempt(r.data?.openAttempts ?? openAttempts + 1);
      router.refresh();
    });
  }

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={pending}
        title="Log that staff attempted to reach the patient. Card shows a 📞 N chip that escalates amber → orange → rose as attempts pile up."
        className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending
          ? "Logging…"
          : openAttempts > 0
            ? `📞 Attempted (${openAttempts}) ▾`
            : "📞 Attempted contact ▾"}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
      {menuOpen ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
          {CONTACT_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              onClick={() => record(reason)}
              className="block w-full px-3 py-1.5 text-left text-xs text-zinc-800 hover:bg-amber-50"
            >
              {reason}
            </button>
          ))}
          <button
            type="button"
            onClick={recordOther}
            className="block w-full border-t border-zinc-100 px-3 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-50"
          >
            Other…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Resets the open-attempt counter on the card. Doesn't delete history —
 * future attempts after this event start a fresh count.
 */
function ReachedButton({
  caseId,
  onReached,
}: {
  caseId: string;
  onReached: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onClick() {
    setError(null);
    start(async () => {
      const r = await markPatientReached(caseId);
      if (!r.ok) {
        setError(r.error ?? "Failed");
        return;
      }
      onReached();
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        title="Clear the contact-attempt tint — staff successfully reached the patient."
        className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
      >
        {pending ? "Saving…" : "✓ Reached"}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

function ScanKitButton({
  caseId,
  hasTracking,
  step1Done,
}: {
  caseId: string;
  hasTracking: boolean;
  step1Done: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onDetect(code: string) {
    setOpen(false);
    setMsg(null);
    start(async () => {
      const r = await attachTrackingFromScan({
        caseId,
        trackingNumber: code,
      });
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      const bits: string[] = [];
      if (r.data?.trackingChanged) bits.push(`TRK ${code} attached`);
      if (r.data?.advancedStep1) bits.push("step 1 marked");
      setMsg(bits.length > 0 ? bits.join(" · ") : "No changes (already on file)");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        title={
          step1Done && hasTracking
            ? "Re-scan to attach a new tracking number"
            : "Scan to attach tracking and advance Step 1"
        }
      >
        Scan kit
      </button>
      {msg ? (
        <span className="text-[11px] text-emerald-700">{msg}</span>
      ) : null}
      {open ? (
        <BarcodeScanner
          title="Scan kit barcode"
          onClose={() => setOpen(false)}
          onDetect={onDetect}
        />
      ) : null}
    </>
  );
}

/**
 * Shared per-draw note editor. Loads the existing draw note on mount and
 * saves on blur (or click of the Save button). Falls back to read-only
 * display of the per-case note when the case has no collection_date —
 * shared notes need a draw date to group by.
 */
function DrawNoteEditor({ row }: { row: LabCase }) {
  const [body, setBody] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [siblingCount, setSiblingCount] = useState<number | null>(null);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const hasDraw = Boolean(row.collection_date);

  useEffect(() => {
    if (!hasDraw) {
      setBody(row.notes ?? "");
      return;
    }
    let cancelled = false;
    getDrawNote(row.id)
      .then((dn) => {
        if (cancelled) return;
        setBody(dn?.body ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load note");
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, row.notes, hasDraw]);

  function save() {
    if (!hasDraw || !dirty) return;
    setError(null);
    startSave(async () => {
      const r = await updateDrawNote({ caseId: row.id, body });
      if (!r.ok) {
        setError(r.error ?? "Failed");
        return;
      }
      setSiblingCount(r.data?.siblingCount ?? null);
      setSavedAt(new Date().toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }));
      setDirty(false);
    });
  }

  if (!hasDraw) {
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-zinc-500">
          Per-case note (no collection date set — shared notes require a draw
          date to group siblings).
        </p>
        <p className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">
          {row.notes || <span className="text-zinc-400">—</span>}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">
          Shared across every lab drawn on {row.collection_date} for this patient.
          {siblingCount && siblingCount > 1 ? (
            <span className="ml-1 text-zinc-700">
              · applies to {siblingCount} cards
            </span>
          ) : null}
        </p>
        {savedAt ? (
          <span className="text-[11px] text-emerald-700">Saved {savedAt}</span>
        ) : null}
      </div>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setDirty(true);
        }}
        onBlur={save}
        rows={3}
        placeholder="Add a note shared across this patient's draw…"
        className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      <div className="flex items-center justify-end gap-2">
        {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}

function ageFromDob(dob: string | null): string {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return ` (age ${age})`;
}

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-zinc-900">
        {children ?? (value ? value : <span className="text-zinc-400">—</span>)}
      </span>
    </div>
  );
}

export function CaseDetail({
  row,
  initialOpenAttempts = 0,
}: {
  row: LabCase;
  /** Open contact attempts from the kanban — lets the action bar render the
   *  Reached button without a roundtrip on first open. */
  initialOpenAttempts?: number;
}) {
  const currentCol = getColumnFor(row);
  const done = completedStepCount(row);
  const workflow = getCaseWorkflow(row);
  const totalSteps = getWorkflowSteps(workflow).length;
  const destination = getLabDestination(row.lab_name, row.lab_panel);
  const destWarning = trackingDestinationWarning({
    labName: row.lab_name,
    labPanel: row.lab_panel,
    trackingStatus: row.tracking_status,
    trackingLocation: row.tracking_location,
  });
  const [openAttempts, setOpenAttempts] = useState(initialOpenAttempts);

  // Pending-PDF state: only relevant when the card sits in pending_upload.
  // Loaded lazily after CaseDetail mounts; if there's no PDF (e.g. card just
  // moved out of the column), pendingPdf stays null and no CTA renders.
  const [pendingPdf, setPendingPdf] = useState<PendingPdf | null>(null);
  const [pendingPdfError, setPendingPdfError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);

  useEffect(() => {
    // Always fetch — getPendingPdfForCase returns null when there's no
    // non-superseded, non-approved PDF, so it self-gates. Don't tie this to
    // `currentCol` because that's computed without the hasPendingPdf flag
    // and can lie ("Complete Results" instead of "Pending Upload"). The
    // banner should appear whenever staff action is owed, period.
    let cancelled = false;
    setReviewLoading(true);
    getPendingPdfForCase(row.id)
      .then((p) => {
        if (!cancelled) setPendingPdf(p);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setPendingPdfError(e instanceof Error ? e.message : "Failed to load PDF");
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <div className="flex flex-col gap-4">
      {/* Patient + Case — two-column grid on lg+, stacks on smaller screens.
       *  The old separate "Patient" and "Case" sections cost vertical space
       *  without adding scannability; merging them and tightening field rows
       *  fits the whole header above the fold in a typical modal. */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Patient &amp; case
          </h3>
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <span>
              {done} / {totalSteps} steps
            </span>
            <ManageLabsButton
              patientName={row.patient_name}
              patientEmail={row.patient_email}
              variant="button"
            />
            <CaseDialog
              mode="edit"
              initial={row}
              triggerLabel="Edit"
              triggerClassName="rounded-md border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50"
            />
          </div>
        </div>
        <div className="grid gap-x-6 gap-y-1.5 lg:grid-cols-2">
          <Field label="Email" value={row.patient_email} />
          <Field
            label="Lab"
            children={
              <span className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span>{labelForCase(row)}</span>
                  <LabPortalLinks labName={row.lab_name} />
                </span>
                <span className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                  <span>
                    Acc#{" "}
                    {row.lab_external_ref ? (
                      <span className="font-medium text-zinc-900">{row.lab_external_ref}</span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </span>
                  {row.lab_external_ref ? null : (
                    <FindResultButton caseId={row.id} labName={row.lab_name} />
                  )}
                </span>
              </span>
            }
          />
          <Field
            label="DOB"
            value={
              row.patient_dob ? `${row.patient_dob}${ageFromDob(row.patient_dob)}` : null
            }
          />
          <Field
            label="Ships to"
            value={
              destination
                ? `${destination.city}${destination.state ? `, ${destination.state}` : ""}`
                : null
            }
          />
          <Field label="Phone" value={row.patient_phone} />
          <Field label="Collected" value={row.collection_date} />
          <Field
            label="Tracking"
            children={
              <span className="flex flex-wrap items-center gap-2">
                <span>{row.tracking_number || <span className="text-zinc-400">—</span>}</span>
                <ScanKitButton
                  caseId={row.id}
                  hasTracking={Boolean(row.tracking_number)}
                  step1Done={Boolean(row.step1_sample_sent)}
                />
              </span>
            }
          />
          <Field
            label="Auto-send"
            value={row.auto_send_emails ? "On" : "Off"}
          />
        </div>
        {destWarning ? (
          <p className="mt-2 rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
            ⚠ {destWarning}
          </p>
        ) : null}
        {row.tracking_number && row.tracking_status ? (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5">
            <p className="text-[11px] text-zinc-700">
              <strong className="capitalize">{row.tracking_status.replace(/_/g, " ")}</strong>
              {row.tracking_location ? ` · ${row.tracking_location}` : ""}
              {row.tracking_status_detail ? ` — ${row.tracking_status_detail}` : ""}
              {row.tracking_polled_at ? (
                <span className="ml-2 text-[10px] text-zinc-400">
                  polled {row.tracking_polled_at.slice(0, 16).replace("T", " ")}
                </span>
              ) : null}
            </p>
            <div className="flex items-center gap-2">
              <RefreshTrackingButton caseId={row.id} />
              <RefreshLabStatusButton caseId={row.id} />
            </div>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-end">
            <RefreshLabStatusButton caseId={row.id} />
          </div>
        )}
      </section>

      {/* Shared draw notes — keyed by patient + collection_date so a
       *  patient with five labs drawn the same day sees one shared note. */}
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Notes
        </h3>
        <DrawNoteEditor row={row} />
      </section>

      {/* PDF review banner — shown whenever a PDF is attached but no
       *  approve / wrong-pdf audit row exists yet. Gate on `pendingPdf`
       *  alone (not on reviewLoading) so the banner doesn't flash on
       *  every card while the server action is in-flight: cards with no
       *  pending PDF should never show it at all. */}
      {pendingPdf ? (
        <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                PDF awaiting review
              </h3>
              <p className="mt-0.5 text-[11.5px] text-amber-800">
                A result PDF was attached by{" "}
                <span className="font-mono">{pendingPdf?.attachedBy ?? "scraper"}</span>
                {pendingPdf?.externalRef
                  ? <>
                      {" "}with accession{" "}
                      <span className="font-mono">{pendingPdf.externalRef}</span>
                    </>
                  : null}
                . Verify the patient + accession + collection date before approving — Approve uploads to PracticeBetter.
              </p>
              {pendingPdfError ? (
                <p className="mt-1 text-[11px] text-red-700">{pendingPdfError}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              disabled={reviewLoading || !pendingPdf}
              onClick={() => setReviewOpen(true)}
            >
              {reviewLoading ? "Loading…" : "Review PDF"}
            </button>
          </div>
        </section>
      ) : null}

      {reviewOpen && pendingPdf ? (
        <PdfReviewModal
          pdf={pendingPdf}
          patientName={row.patient_name}
          onClose={(result) => {
            setReviewOpen(false);
            if (result.actionTaken !== "cancel") {
              // Card has now left pending_upload (approve) or had its PDF
              // superseded (wrong_pdf). Hide the banner immediately; the
              // server refetch on next nav will reconcile.
              setPendingPdf(null);
            }
          }}
        />
      ) : null}

      {/* Steps + action bar. Dropped the "Process" column-strip section —
       *  the workflow column is implicit in the checked steps below and the
       *  badge in the dialog header. */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Steps
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <ContactAttemptButton
              caseId={row.id}
              openAttempts={openAttempts}
              onAttempt={setOpenAttempts}
            />
            {openAttempts > 0 ? (
              <ReachedButton
                caseId={row.id}
                onReached={() => setOpenAttempts(0)}
              />
            ) : null}
            <MarkClosedButton
              caseId={row.id}
              isAlreadyClosed={currentCol === "closed"}
              isPeptides={workflow === "peptides"}
            />
          </div>
        </div>
        <StepChecklist initial={row} />
      </section>

      {/* Emails + Activity — side by side on lg+, each compact (latest 5
       *  with internal scroll on expand). Saves a chunk of vertical
       *  scrolling versus the old stacked panels. */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Emails
          </h3>
          <EmailLogPanel caseId={row.id} compact />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Activity
          </h3>
          <ActivityLog caseId={row.id} compact />
        </div>
      </section>

      <section className="border-t border-zinc-200 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Danger zone
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <ArchiveCaseButton
              caseId={row.id}
              isArchived={Boolean(row.archived_at)}
            />
            <DeleteCaseButton caseId={row.id} />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          <span className="font-medium text-zinc-600">Archive</span> moves the
          case to the Completed lane (recoverable, keeps email history visible).{" "}
          <span className="font-medium text-zinc-600">Delete</span> soft-deletes
          it — recoverable from Settings → Deleted.
        </p>
      </section>
    </div>
  );
}
