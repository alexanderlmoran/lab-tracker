"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  completedStepCount,
  getCaseWorkflow,
  getColumnFor,
  getWorkflowSteps,
} from "@/lib/columns";
import { StepChecklist } from "./StepChecklist";
import { useDismiss } from "./use-dismiss";
import { ActivityLog } from "./ActivityLog";
import { EmailLogPanel } from "./EmailLogPanel";
import { BarcodeScanner } from "./BarcodeScanner";
import { CaseDialog } from "./CaseDialog";
import { PdfReviewModal } from "./PdfReviewModal";
import { getPendingPdfForCase, getResultPdfForCase, type PendingPdf } from "./pdf-actions";
import { LabPortalLinks } from "./LabPortalLinks";
import { FindResultButton } from "./FindResultButton";
import { ManageLabsButton } from "./PatientLabManager";
import { RefreshLabStatusButton } from "./RefreshLabStatusButton";
import { RefreshTrackingButton } from "./RefreshTrackingButton";
import { ReqFormButton } from "./ReqFormButton";
import {
  archiveLabCase,
  attachTrackingFromScan,
  deleteLabCase,
  markCaseClosed,
  unarchiveLabCase,
} from "./actions";
import {
  getDrawNote,
  listContactAttempts,
  markPatientReached,
  recordContactAttempt,
  updateDrawNote,
  type ContactEvent,
} from "./draw-actions";
import { useRouter } from "next/navigation";
import { getLabDestination, trackingDestinationWarning } from "@/lib/labs/catalog";
import { labelForCase } from "@/lib/labs/label";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import { isLastNameMismatch } from "@/lib/labs/patient-name";
import { ManualUploadButton } from "./ManualUploadButton";
import { getAdapterFor } from "@/lib/lab-adapters";

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

  useDismiss(wrapRef, menuOpen, () => setMenuOpen(false));

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
      if (r.data?.readyToShip) bits.push("→ Ready to ship");
      setMsg(bits.length > 0 ? bits.join(" · ") : "No changes (already on file)");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Notes
          </h3>
        </div>
        <p className="mb-1 text-[11px] text-zinc-500">
          Per-case note (no collection date set — shared notes require a draw
          date to group siblings).
        </p>
        <p className="min-h-[120px] flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">
          {row.notes || <span className="text-zinc-400">—</span>}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: title left, Save/Saved status top-right (aligned with the
          other cards' header actions). The old bottom button row is gone, so
          the textarea owns all the vertical space below. */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Notes
        </h3>
        <div className="flex items-center gap-2">
          {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            title={savedAt ? `Last saved ${savedAt}` : undefined}
            className={`rounded-md border px-2.5 py-0.5 text-[11px] disabled:cursor-default disabled:opacity-100 ${
              dirty
                ? "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                : savedAt
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-zinc-200 bg-white text-zinc-400"
            }`}
          >
            {saving ? "Saving…" : dirty ? "Save" : savedAt ? `Saved ${savedAt}` : "Saved"}
          </button>
        </div>
      </div>
      <p className="mb-1 text-[11px] text-zinc-500">
        Shared across every lab drawn on {row.collection_date} for this patient.
        {siblingCount && siblingCount > 1 ? (
          <span className="ml-1 text-zinc-700">· applies to {siblingCount} cards</span>
        ) : null}
      </p>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setDirty(true);
        }}
        onBlur={save}
        placeholder="Add a note shared across this patient's draw…"
        className="min-h-[120px] w-full flex-1 resize-none rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
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
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="w-16 shrink-0 text-[10.5px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 text-zinc-900 ${children ? "" : "truncate"}`}
        title={!children && typeof value === "string" ? value : undefined}
      >
        {children ?? (value ? value : <span className="text-zinc-400">—</span>)}
      </span>
    </div>
  );
}

/** Compact calls/texts log for the Communications card — contact attempts +
 *  "reached" events, newest first. */
function CallsLog({ caseId }: { caseId: string }) {
  const [events, setEvents] = useState<ContactEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listContactAttempts(caseId)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [caseId]);
  if (events === null) {
    return <p className="text-[11px] text-zinc-400">Loading…</p>;
  }
  if (events.length === 0) {
    return <p className="text-[11px] text-zinc-500">No calls or texts logged.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {events.slice(0, 6).map((e) => (
        <li key={e.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
          <span
            className={`mt-px shrink-0 rounded px-1 text-[10px] font-medium ${
              e.kind === "contact_reached"
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {e.kind === "contact_reached" ? "Reached" : "Attempt"}
          </span>
          <span className="min-w-0 flex-1 text-zinc-700">
            {e.note ? `${e.note} · ` : ""}
            <span className="text-zinc-400">
              {new Date(e.created_at).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CaseDetail({
  row,
  initialOpenAttempts = 0,
  autoReview = false,
  hasPendingPdf = false,
  dupSiblings,
}: {
  row: LabCase;
  /** Open contact attempts from the kanban — lets the action bar render the
   *  Reached button without a roundtrip on first open. */
  initialOpenAttempts?: number;
  /** When the card was opened via its "Review" CTA (a Pending-Upload card),
   *  auto-open the PDF review modal as soon as the pending PDF loads — saves
   *  the open-dialog → find-banner → click-Review steps. */
  autoReview?: boolean;
  /** The board already knows (from `pendingPdfCaseIds`) whether this case has a
   *  PDF awaiting review. Passing it lets the PDF-review card spawn IMMEDIATELY
   *  on open (shell while the full detail loads) instead of after the probe. */
  hasPendingPdf?: boolean;
  /** Other cards sharing this card's accession (same physical order split across
   *  cards). When present, the dialog shows the merged order: every sibling's
   *  lab + tracking #, and review actions cascade across the group. */
  dupSiblings?: LabCase[];
}) {
  const currentCol = getColumnFor(row);
  const done = completedStepCount(row);
  const workflow = getCaseWorkflow(row);
  const totalSteps = getWorkflowSteps(workflow).length;
  // "Refresh lab status" is the legacy LabCorp/Quest pull system; the real
  // portals use the worker scrapers + the "Find result" probe. Only show it
  // when an adapter actually exists, so DoctorsData et al. don't surface a
  // confusing "No adapter" error.
  const hasStatusAdapter = getAdapterFor(row.lab_name) != null;
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
  // Start TRUE: loadPendingPdf fires on mount, so the very first paint is already
  // "checking" — this stops the "No result staged yet" staged card from flashing
  // for one frame before the PDF-review card resolves.
  const [reviewLoading, setReviewLoading] = useState(true);

  // Already-uploaded result PDF — viewable in every lane right of Pending
  // Upload once the result was successfully posted (step5_complete_uploaded).
  // Loaded lazily on click so opening a card doesn't sign a URL it won't use.
  const [resultPdf, setResultPdf] = useState<PendingPdf | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  // "Move same-order cards together" lives up here so its checkbox can sit in
  // the Same-order panel (its natural home) while StepChecklist still reads it.
  const [moveSiblings, setMoveSiblings] = useState(true);
  function openResultPdf() {
    setResultError(null);
    setResultLoading(true);
    getResultPdfForCase(row.id)
      .then((p) => {
        if (!p) {
          setResultError("No stored PDF on file for this result.");
          return;
        }
        setResultPdf(p);
        setResultOpen(true);
      })
      .catch((e: unknown) =>
        setResultError(e instanceof Error ? e.message : "Failed to load PDF"),
      )
      .finally(() => setResultLoading(false));
  }

  // Load (or reload) the case's pending PDF. Always fetch — getPendingPdfForCase
  // returns null when there's no non-superseded, non-approved PDF, so it self-
  // gates. Don't tie this to `currentCol` (computed without the hasPendingPdf
  // flag, it can lie). `openReview` opens the review modal once it loads — used
  // after a manual "search for lab to post" stages a PDF so the operator reviews
  // it in place instead of closing + reopening the card.
  const loadPendingPdf = useCallback(
    (openReview = false) => {
      let cancelled = false;
      setReviewLoading(true);
      getPendingPdfForCase(row.id)
        .then((p) => {
          if (cancelled) return;
          setPendingPdf(p);
          if (p && (openReview || autoReview)) setReviewOpen(true);
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
    },
    [row.id, autoReview],
  );
  useEffect(() => loadPendingPdf(), [loadPendingPdf]);

  // ── Mid-section cards ──────────────────────────────────────────────────────
  // Notes, Same-order, and the PDF-review / no-result-staged cards are all
  // bordered sub-cards following the same header pattern (title/status left,
  // primary action top-right). They lock into a strict 2-up grid below — never
  // loose full-width banners.
  const hasSiblings = Boolean(dupSiblings && dupSiblings.length > 0);
  const pdfMismatch = pendingPdf
    ? isLastNameMismatch(pendingPdf.reportPatientName, row.patient_name)
    : false;
  // Stuck Pending/Sample card with no PDF staged yet — manual probe / upload.
  const showStaged =
    (currentCol === "pending_upload" || currentCol === "sample_sent") &&
    !pendingPdf &&
    !reviewLoading;
  const hasScraper = showStaged ? Boolean(probeKeyForLab(row.lab_name)) : false;

  const notesCard = (
    <section key="notes" className="flex flex-1 flex-col rounded-lg border border-zinc-200 p-4">
      <DrawNoteEditor row={row} />
    </section>
  );

  const sameOrderCard = hasSiblings ? (
    <section key="siblings" className="flex flex-col rounded-lg border border-purple-200 bg-purple-50/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-xs font-semibold uppercase tracking-wide text-purple-800">
          Same order — {dupSiblings!.length + 1} cards
          {row.lab_external_ref ? (
            <span className="font-mono normal-case text-purple-600"> · ACC# {row.lab_external_ref}</span>
          ) : null}
        </h3>
        <button
          type="button"
          onClick={() => setMoveSiblings((v) => !v)}
          title={`When on, ticking a step moves all ${dupSiblings!.length + 1} cards in this order together.`}
          aria-pressed={moveSiblings}
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
            moveSiblings
              ? "border-purple-300 bg-purple-100 text-purple-800"
              : "border-zinc-300 bg-white text-zinc-500 hover:bg-zinc-50"
          }`}
        >
          {moveSiblings ? "✓ Grouped" : "Grouped"}
        </button>
      </div>
      <p className="mt-0.5 text-[10.5px] leading-snug text-purple-700">
        One order split across cards. Approve / Already-on-PB / Disapprove applies to all.
      </p>
      <div className="mt-1.5 divide-y divide-purple-100 overflow-hidden rounded border border-purple-100 bg-white">
        {[row, ...dupSiblings!].map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 px-2 py-0.5 text-[11.5px]"
          >
            <span className="truncate text-zinc-900">{labelForCase(c)}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-zinc-600">
              {c.tracking_number ? `TRK ${c.tracking_number}` : "— no tracking —"}
            </span>
          </div>
        ))}
      </div>
    </section>
  ) : null;

  // PDF awaiting review — bordered sub-card (header pattern): title/status left,
  // [Review PDF] top-right. A wrong-patient mismatch reds out the whole card.
  // Spawns IMMEDIATELY on open when the parent's `hasPendingPdf` hint is set
  // (known instantly) — the shell renders while the full PDF detail loads, so
  // there's no skeleton→card flash. If the hint turns out stale (probe returns
  // no PDF) the card drops once loading finishes.
  // Spawn the PDF-review card immediately on open while the detail loads, for
  // any case we expect to have one: the parent's hint OR simply being in the
  // Pending Upload lane (its whole purpose is a PDF awaiting Approve). If the
  // probe then finds none, it falls back to the staged card — no skeleton, and
  // no wrong "No result staged" flash on a card that does have a PDF.
  const showReview =
    Boolean(pendingPdf) ||
    ((hasPendingPdf || currentCol === "pending_upload") && reviewLoading);
  const reviewCard = showReview ? (
    <section
      key="review"
      className={`flex flex-1 flex-col rounded-lg border p-4 ${
        pdfMismatch ? "border-red-400 bg-red-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`min-w-0 text-xs font-semibold uppercase tracking-wide ${
            pdfMismatch ? "text-red-900" : "text-amber-900"
          }`}
        >
          {pdfMismatch ? "⚠ Patient mismatch" : "PDF awaiting review"}
        </h3>
        <button
          type="button"
          className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-0.5 text-[11px] font-medium text-white disabled:opacity-50 ${
            pdfMismatch ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700"
          }`}
          disabled={reviewLoading || !pendingPdf}
          onClick={() => setReviewOpen(true)}
        >
          {reviewLoading ? "Loading…" : "Review PDF"}
        </button>
      </div>
      {pdfMismatch ? (
        <p className="mt-1 text-[11.5px] font-medium leading-snug text-red-800">
          Staged report is for{" "}
          <span className="font-mono">{pendingPdf?.reportPatientName}</span>, but this case is{" "}
          <span className="font-mono">{row.patient_name}</span>. Do NOT upload until you confirm
          the patient — open Review.
        </p>
      ) : pendingPdf ? (
        <p className="mt-1 text-[11.5px] leading-snug text-amber-800">
          A result PDF was attached by{" "}
          <span className="font-mono">{pendingPdf.attachedBy ?? "scraper"}</span>
          {pendingPdf.externalRef ? (
            <>
              {" "}with accession <span className="font-mono">{pendingPdf.externalRef}</span>
            </>
          ) : null}
          . Verify the patient + accession + collection date before approving — Approve uploads
          to PracticeBetter.
        </p>
      ) : (
        <p className="mt-1 text-[11.5px] leading-snug text-amber-800">
          A result PDF is attached and awaiting review — open Review to verify the patient,
          accession, and collection date before approving.
        </p>
      )}
      {pendingPdfError ? (
        <p className="mt-1 text-[11px] text-red-700">{pendingPdfError}</p>
      ) : null}
    </section>
  ) : null;

  // No result staged yet — bordered sub-card (header pattern): primary probe in
  // the top-right header, manual upload as the secondary action in the body.
  const stagedCard = showStaged ? (
    <section
      key="staged"
      className={`flex flex-1 flex-col rounded-lg border p-4 ${
        hasScraper ? "border-indigo-200 bg-indigo-50" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`min-w-0 text-xs font-semibold uppercase tracking-wide ${
            hasScraper ? "text-indigo-900" : "text-zinc-700"
          }`}
        >
          {hasScraper ? "No result staged yet" : "No auto-scraper"}
        </h3>
        {hasScraper ? (
          <FindResultButton
            caseId={row.id}
            labName={row.lab_name}
            idleLabel="Search portal"
            busyLabel="Searching…"
            stageOnFind
            onStaged={() => loadPendingPdf(true)}
          />
        ) : (
          <ManualUploadButton
            caseId={row.id}
            onUploaded={() => loadPendingPdf(true)}
            label="Upload PDF"
          />
        )}
      </div>
      <p className={`mt-1 text-[11.5px] leading-snug ${hasScraper ? "text-indigo-800" : "text-zinc-600"}`}>
        {!hasScraper
          ? `${row.lab_name} has no portal scraper — its result can't be auto-pulled. Post it manually (from the lab's email/portal) once it's in.`
          : currentCol === "sample_sent"
            ? "Sample's at the lab — if the portal already has a result, pull it now to review (early results land before the predicted window)."
            : "The worker hasn't attached a PDF to post yet. Search the lab portal now for this patient's result to review."}
      </p>
      {hasScraper ? (
        <div className="mt-1.5">
          <ManualUploadButton
            caseId={row.id}
            onUploaded={() => loadPendingPdf(true)}
            label="or upload a PDF"
          />
        </div>
      ) : null}
    </section>
  ) : null;

  // Right-column slot: keep the middle row a 2-up grid so Notes never flexes
  // 50%→100% while the pending-PDF probe is in flight. In result-bearing columns
  // we reserve the slot with a skeleton during the fetch (a non-result case never
  // flashes one and reflows). When there's genuinely nothing to show, the slot
  // renders NOTHING — a seamless black void matching the board, not a highlighted
  // "empty" placeholder (the Black Void rule). Notes still holds its half-width.
  const inResultColumn =
    currentCol === "pending_upload" || currentCol === "sample_sent";

  const loadingCard = (
    <section key="loading" className="flex flex-1 flex-col rounded-lg border border-zinc-200 p-4">
      <div className="h-3 w-28 animate-pulse rounded bg-zinc-200" />
      <div className="mt-3 space-y-2">
        <div className="h-2.5 w-full animate-pulse rounded bg-zinc-100" />
        <div className="h-2.5 w-4/5 animate-pulse rounded bg-zinc-100" />
      </div>
    </section>
  );

  // The right-column "action" slot: PDF-review xor staged (mutually exclusive on
  // pendingPdf), or the skeleton while a result-column probe resolves. null when
  // the case isn't a result column (so the next card shifts up into the slot).
  const actionCard =
    reviewCard ?? stagedCard ?? (inResultColumn && reviewLoading ? loadingCard : null);

  const communicationsCard = (
    <section key="comms" className="flex flex-col rounded-lg border border-zinc-200 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Communications
      </h3>
      <div className="flex flex-col gap-3">
        <div>
          <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">
            Emails
          </h4>
          <EmailLogPanel caseId={row.id} compact />
        </div>
        <div>
          <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">
            Calls &amp; texts
          </h4>
          <CallsLog caseId={row.id} />
        </div>
      </div>
    </section>
  );

  const activityCard = (
    <section key="activity" className="flex flex-col rounded-lg border border-zinc-200 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Activity
      </h3>
      <div className="max-h-48 min-h-0 flex-1 overflow-y-auto pr-1">
        <ActivityLog caseId={row.id} compact />
      </div>
    </section>
  );

  // Every lower card packs into ONE dense 2-up grid in priority order. Absent
  // cards (no PDF, no siblings) aren't rendered at all, so the next card shifts
  // UP to fill the slot — Activity rises into a blank action slot instead of a
  // gap. Any leftover odd cell trails at the very bottom as a seamless void.
  const lowerCards = [
    notesCard,
    actionCard,
    sameOrderCard,
    communicationsCard,
    activityCard,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      {/* Patient + Case — two-column grid on lg+, stacks on smaller screens.
       *  The old separate "Patient" and "Case" sections cost vertical space
       *  without adding scannability; merging them and tightening field rows
       *  fits the whole header above the fold in a typical modal. */}
      {/* Top row: case details (left) + step progress (right) side by side,
          stretched to equal height so the two outer cards read as a balanced,
          symmetrical pair. Clipping is solved INSIDE the Steps card (compact
          fonts / hint-on-own-line / shrunk buttons), not by widening it. */}
      <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-zinc-200 p-4">
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
            {/* View the uploaded result PDF — available once it was posted to PB
             *  (step5), in every lane right of Pending Upload. Lazy-loaded. */}
            {row.step5_complete_uploaded ? (
              <button
                type="button"
                onClick={openResultPdf}
                disabled={resultLoading}
                title={resultError ?? "View / download the uploaded result PDF"}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {resultLoading ? "Loading…" : resultError ? "No PDF on file" : "View PDF"}
              </button>
            ) : null}
            <CaseDialog
              mode="edit"
              initial={row}
              triggerLabel="Edit"
              triggerClassName="rounded-md border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50"
            />
          </div>
        </div>
        {/* Lab on its own flat row (name · Portal · Acc# on one line), the short
            patient fields packed 2-up, then tracking on its own flat row (number
            + Scan kit + carrier status + Refresh, all inline). Dense + horizontal
            — no bordered status box, no careless vertical stacking. */}
        <div className="flex flex-col gap-2">
          <Field label="Lab">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium">{labelForCase(row)}</span>
              <LabPortalLinks labName={row.lab_name} />
              <span className="text-[12px] text-zinc-500">
                Acc#{" "}
                {row.lab_external_ref ? (
                  <span className="font-medium text-zinc-700">{row.lab_external_ref}</span>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </span>
              {row.lab_external_ref ? null : (
                <FindResultButton caseId={row.id} labName={row.lab_name} />
              )}
            </span>
          </Field>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <Field label="Email" value={row.patient_email} />
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
              label="DOB"
              value={
                row.patient_dob ? `${row.patient_dob}${ageFromDob(row.patient_dob)}` : null
              }
            />
            <Field label="Auto-send" value={row.auto_send_emails ? "On" : "Off"} />
          </div>
          <Field label="Tracking">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{row.tracking_number || <span className="text-zinc-400">—</span>}</span>
              {/* Scan kit attaches a tracking #, so it's only useful before one
                  exists — once a code is on file it's just clutter on the row. */}
              {row.tracking_number ? null : (
                <ScanKitButton
                  caseId={row.id}
                  hasTracking={false}
                  step1Done={Boolean(row.step1_sample_sent)}
                />
              )}
              {row.tracking_number && row.tracking_status ? (
                <>
                  <span
                    className="text-[12px] text-zinc-600"
                    title={
                      row.tracking_polled_at
                        ? `polled ${row.tracking_polled_at.slice(0, 16).replace("T", " ")}`
                        : undefined
                    }
                  >
                    <strong className="capitalize text-zinc-700">{row.tracking_status.replace(/_/g, " ")}</strong>
                    {row.tracking_location ? ` · ${row.tracking_location}` : ""}
                  </span>
                  {/* Delivered is terminal — no point refreshing, so the row
                      collapses to just the code + status + location. */}
                  {row.tracking_status === "delivered" ? null : (
                    <RefreshTrackingButton caseId={row.id} />
                  )}
                  {hasStatusAdapter ? <RefreshLabStatusButton caseId={row.id} /> : null}
                </>
              ) : hasStatusAdapter ? (
                <RefreshLabStatusButton caseId={row.id} />
              ) : null}
            </span>
          </Field>
          {/* Req-form — only pre-ship (hidden from Sample Sent on, the req left
              with the kit), so the card ends clean and aligned otherwise. */}
          {currentCol === "untouched" || currentCol === "ready_to_ship" || currentCol === "with_patient" ? (
            <ReqFormButton caseId={row.id} labName={row.lab_name} />
          ) : null}
          {destWarning ? (
            <p className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
              ⚠ {destWarning}
            </p>
          ) : null}
        </div>
      </section>
      {/* Steps — right column of the top row. flex-col so the checklist can
          vertically center and fill the stretched card (no top-heavy clump with
          a big empty gap at the bottom). */}
      <section className="flex flex-col rounded-lg border border-zinc-200 p-4">
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
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
              <ReachedButton caseId={row.id} onReached={() => setOpenAttempts(0)} />
            ) : null}
            <MarkClosedButton
              caseId={row.id}
              isAlreadyClosed={currentCol === "closed"}
              isPeptides={workflow === "peptides"}
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col justify-center">
          <StepChecklist
            initial={row}
            siblingCount={dupSiblings?.length ?? 0}
            moveSiblings={moveSiblings}
          />
        </div>
      </section>
      </div>

      {/* All lower cards pack into ONE dense 2-up grid (Notes → action → Same-
          order → Communications → Activity). Absent cards aren't rendered, so
          each subsequent card shifts UP to fill the slot — Activity rises into a
          blank action slot rather than leaving a gap. `auto-rows` keeps every row
          equal-height (identical borders); any odd trailing cell is a seamless
          void. Notes always holds its half-width (the grid never goes 1-col). */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">{lowerCards}</div>

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

      {resultOpen && resultPdf ? (
        <PdfReviewModal
          pdf={resultPdf}
          patientName={row.patient_name}
          readOnly
          onClose={() => setResultOpen(false)}
        />
      ) : null}


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
