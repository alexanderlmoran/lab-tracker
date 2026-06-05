"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  LAB_BOARD_COLUMN_ORDER,
  type ColumnKey,
  expectedCountdown,
  getCaseStaleness,
  getColumnFor,
} from "@/lib/columns";
import { trackingDestinationWarning } from "@/lib/labs/catalog";
import { labelForCase } from "@/lib/labs/label";
import { CaseDetail } from "./CaseDetail";
import { formatPersonName, formatShortDate } from "@/lib/format";
import {
  ZERO_COUNTS,
  attemptCardClasses,
  CHIP,
  TRACKING_BADGE,
  RailChip,
  AttemptRailChip,
  EmailRailChip,
  type CardCounts,
} from "./card-counts";

function formatExpectedRange(min: string | null, max: string | null): string | null {
  if (!min && !max) return null;
  const fmt = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (min && max && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt(max ?? min ?? "");
}

function isProbablyReady(row: LabCase): boolean {
  if (row.step4_complete_received) return false;
  if (row.tracking_status !== "delivered") return false;
  if (!row.expected_result_at_max) return false;
  const today = new Date();
  const today0 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return row.expected_result_at_max <= today0;
}

function LabCard({
  row,
  onOpen,
  counts,
  dupSiblings,
  hasPendingPdf,
}: {
  row: LabCase;
  onOpen: (row: LabCase, autoReview?: boolean) => void;
  counts: CardCounts;
  /** Other cards for the same patient sharing this card's accession. */
  dupSiblings?: LabCase[];
  /** A result PDF is staged awaiting Approve — clicking the card jumps straight
   *  to the review modal. */
  hasPendingPdf?: boolean;
}) {
  const expected = formatExpectedRange(
    row.expected_result_at_min,
    row.expected_result_at_max,
  );
  const stale = getCaseStaleness(row);
  const probablyReady = isProbablyReady(row);
  const countdown = expectedCountdown(row);
  const destWarning = trackingDestinationWarning({
    labName: row.lab_name,
    labPanel: row.lab_panel,
    trackingStatus: row.tracking_status,
    trackingLocation: row.tracking_location,
  });
  const labLabel = labelForCase(row);
  const trackingMeta = row.tracking_status
    ? TRACKING_BADGE[row.tracking_status]
    : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(row, hasPendingPdf)}
      className={`flex w-full gap-2 rounded-md border p-1.5 text-left shadow-sm transition-shadow hover:shadow ${
        hasPendingPdf
          ? "border-amber-400 bg-amber-50"
          : probablyReady
            ? "border-blue-300 bg-blue-50"
            : attemptCardClasses(counts.openAttempts)
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[13px] font-medium leading-tight text-zinc-900">
          {labLabel}
        </p>
        <p className="truncate text-[12px] text-zinc-500">
          {formatPersonName(row.patient_name)}
        </p>
        {expected || row.tracking_number ? (
          <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-400">
            {expected ? <span>↳ {expected}</span> : null}
            {row.tracking_number ? (
              <span className="truncate">TRK {row.tracking_number}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {hasPendingPdf ? (
          <RailChip
            className="border-amber-400 bg-amber-100 font-semibold text-amber-800"
            title="Result PDF staged — click to review & approve"
          >
            review
          </RailChip>
        ) : null}
        {trackingMeta ? (
          <RailChip
            className={trackingMeta.className}
            title={row.tracking_status_detail ?? undefined}
          >
            {trackingMeta.label}
          </RailChip>
        ) : row.tracking_status ? (
          <RailChip className={CHIP.muted}>{row.tracking_status}</RailChip>
        ) : null}
        {probablyReady ? (
          <RailChip
            className={CHIP.state}
            title="Likely ready — check lab portal"
          >
            ready?
          </RailChip>
        ) : null}
        {dupSiblings && dupSiblings.length > 0 ? (
          <RailChip
            className="border-purple-300 bg-purple-50 text-purple-700"
            title={`Same ACC# ${row.lab_external_ref} as ${dupSiblings.length} other card(s) for this patient — likely one lab split into multiple cards (e.g. PT/PTT/PT-INR). Tracking#: ${dupSiblings.map((s) => s.tracking_number ?? "—").join(", ")}. Merge/dismiss the extras.`}
          >
            dup ×{dupSiblings.length + 1}
          </RailChip>
        ) : null}
        <AttemptRailChip openAttempts={counts.openAttempts} />
        {countdown ? (
          <RailChip
            className={
              countdown.tone === "overdue"
                ? CHIP.alert
                : countdown.tone === "due"
                  ? CHIP.caution
                  : CHIP.good
            }
            title={
              countdown.tone === "overdue"
                ? `Expected by ${formatShortDate(row.expected_result_at_max)} — past`
                : `Expected by ${formatShortDate(row.expected_result_at_max)}`
            }
          >
            {countdown.label}
          </RailChip>
        ) : null}
        {destWarning ? (
          <RailChip className={CHIP.warn} title={destWarning}>
            wrong city?
          </RailChip>
        ) : null}
        <EmailRailChip emailCount={counts.emailCount} />
        {stale.stale ? (
          <RailChip
            className={CHIP.caution}
            title={`No progress in ${stale.daysSinceProgress} days`}
          >
            {stale.daysSinceProgress}d
          </RailChip>
        ) : null}
      </div>
    </button>
  );
}

function StaticColumn({
  col,
  count,
  children,
}: {
  col: ColumnKey;
  count: number;
  children: React.ReactNode;
}) {
  // Pending Upload is the one lane that owes a human action (Approve → PB). Make
  // it pop when it has cases so it can't hide among the 9 equal-width columns.
  const needsAction = col === "pending_upload" && count > 0;
  return (
    <section
      className={`kanban-col flex min-w-0 flex-1 basis-0 flex-col p-1.5 lg:min-h-0 ${
        needsAction ? "rounded-md bg-amber-50/50 ring-1 ring-amber-300" : ""
      }`}
      data-col={col}
    >
      <header className="flex items-center justify-between px-1.5 py-1">
        <h3 className={`col-head-title ${needsAction ? "text-amber-800" : ""}`}>
          {needsAction ? "● " : ""}
          {COLUMN_LABEL[col]}
        </h3>
        <span
          className={
            needsAction
              ? "rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
              : "col-head-count"
          }
        >
          {count}
        </span>
      </header>
      <div className="flex min-h-[40px] flex-col gap-1.5 p-0.5 lg:flex-1 lg:overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

export function LabKanbanBoard({
  rows,
  counts,
  pendingPdfCaseIds,
}: {
  rows: LabCase[];
  counts?: Record<string, CardCounts>;
  /** Case IDs whose attached PDF is still waiting on staff Approve/Wrong-PDF.
   * Used to lift those rows into the "Pending Upload" column. */
  pendingPdfCaseIds?: string[];
}) {
  const pendingPdfSet = useMemo(
    () => new Set(pendingPdfCaseIds ?? []),
    [pendingPdfCaseIds],
  );
  const searchParams = useSearchParams();

  const probablyReadyOnly = searchParams.get("ready") === "1";
  const staleOnly = searchParams.get("stale") === "1";

  const filtered = useMemo(() => {
    let list = rows;
    if (probablyReadyOnly) list = list.filter(isProbablyReady);
    if (staleOnly) list = list.filter((r) => getCaseStaleness(r).stale);
    return list;
  }, [rows, probablyReadyOnly, staleOnly]);

  // Same-accession duplicate detection. One patient with >1 card sharing the
  // SAME accession is almost always one lab split into multiple tracker cards
  // (e.g. a PT/PTT/PT-INR shipped together — same draw, same accession, separate
  // tracking#). Flag them so staff merge/dismiss the extras instead of uploading
  // the same result twice. Computed over ALL rows so siblings in other columns
  // still count. Keyed by patient + accession.
  const dupByCaseId = useMemo(() => {
    const groups = new Map<string, LabCase[]>();
    for (const r of rows) {
      const ref = r.lab_external_ref?.trim();
      if (!ref) continue;
      const who = (r.patient_email || r.patient_name || "").trim().toLowerCase();
      const key = `${who}::${ref}`;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    const out = new Map<string, LabCase[]>();
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      for (const r of arr) out.set(r.id, arr.filter((x) => x.id !== r.id));
    }
    return out;
  }, [rows]);

  const grouped: Record<ColumnKey, LabCase[]> = {
    untouched: [],
    sample_sent: [],
    partial_results: [],
    complete_results: [],
    pending_upload: [],
    rof_scheduled: [],
    rof_done: [],
    closed: [],
    completed: [],
  };
  for (const r of filtered) {
    grouped[getColumnFor(r, { hasPendingPdf: pendingPdfSet.has(r.id) })].push(r);
  }
  for (const col of LAB_BOARD_COLUMN_ORDER) {
    grouped[col].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeRow, setActiveRow] = useState<LabCase | null>(null);
  const [autoReview, setAutoReview] = useState(false);

  function openLabDetail(row: LabCase, review = false) {
    setActiveRow(row);
    setAutoReview(review);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function closeDialog() {
    dialogRef.current?.close();
    setActiveRow(null);
  }

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    function onClose() {
      setActiveRow(null);
    }
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-row flex-nowrap gap-1.5 pb-2 lg:flex-1 lg:min-h-0">
        {LAB_BOARD_COLUMN_ORDER.map((col) => {
          const colRows = grouped[col];
          return (
            <StaticColumn key={col} col={col} count={colRows.length}>
              {colRows.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
              ) : (
                colRows.map((row) => (
                  <LabCard
                    key={row.id}
                    row={row}
                    onOpen={openLabDetail}
                    counts={counts?.[row.id] ?? ZERO_COUNTS}
                    dupSiblings={dupByCaseId.get(row.id)}
                    hasPendingPdf={pendingPdfSet.has(row.id)}
                  />
                ))
              )}
            </StaticColumn>
          );
        })}
      </div>

      <dialog
        ref={dialogRef}
        className="w-full max-w-3xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {activeRow ? (
          <div className="flex max-h-[88dvh] flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">
                  {formatPersonName(activeRow.patient_name)}
                </h2>
                <p className="text-xs text-zinc-500">
                  {labelForCase(activeRow)}
                  {" · "}
                  {COLUMN_LABEL[getColumnFor(activeRow)]}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Close"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-5">
              <CaseDetail
                // Render from the freshest row by id (router.refresh updates
                // `rows`); activeRow is only the "which card is open" pointer,
                // so without this an in-dialog edit wouldn't show until reopen.
                row={rows.find((r) => r.id === activeRow.id) ?? activeRow}
                initialOpenAttempts={counts?.[activeRow.id]?.openAttempts ?? 0}
                autoReview={autoReview}
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-3">
              <Link
                href={`/labs/${activeRow.id}`}
                className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                Open in full page →
              </Link>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
