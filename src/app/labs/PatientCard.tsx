"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  completedStepCount,
  expectedCountdown,
  getCaseStaleness,
  getColumnFor,
  type PatientGroup,
} from "@/lib/columns";
import { trackingDestinationWarning } from "@/lib/labs/catalog";
import { labelForCase } from "@/lib/labs/label";
import { CaseDetail } from "./CaseDetail";
import { ManageLabsButton } from "./PatientLabManager";
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

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * SSR-safe relative time. Server renders empty (Date.now on server differs
 * from Date.now on client by enough to flip the rounded minute count), then
 * client fills in after mount and refreshes every 30s while visible.
 */
function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string>("");
  useEffect(() => {
    setText(timeAgo(iso));
    const id = setInterval(() => setText(timeAgo(iso)), 30_000);
    return () => clearInterval(id);
  }, [iso]);
  return <>{text}</>;
}

function formatExpectedRange(min: string | null, max: string | null): string | null {
  if (!min && !max) return null;
  const fmt = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (min && max && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt(max ?? min ?? "");
}

/**
 * "Probably ready" alert criteria — surfaces a case that very likely has
 * results back from the lab but hasn't been marked as complete yet.
 *
 * Triggers when:
 *   • tracking shows the sample was delivered to the lab, AND
 *   • the expected-result-by date (catalog turnaround + sample-sent date)
 *     has passed, AND
 *   • step 4 (complete results received) is not yet checked.
 *
 * Deliberately does NOT auto-toggle step 4 — the human-confirmation gate is
 * core to the workflow. The badge tells staff "go look," not "consider it
 * done."
 */
function isProbablyReady(row: LabCase): boolean {
  if (row.step4_complete_received) return false;
  if (row.tracking_status !== "delivered") return false;
  if (!row.expected_result_at_max) return false;
  const today = new Date();
  const today0 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return row.expected_result_at_max <= today0;
}

function LabRow({
  row,
  onOpen,
  isLaggard,
  counts,
}: {
  row: LabCase;
  onOpen: (row: LabCase) => void;
  isLaggard: boolean;
  counts: CardCounts;
}) {
  const staleness = getCaseStaleness(row);
  const labLabel = labelForCase(row);
  const expected = formatExpectedRange(
    row.expected_result_at_min,
    row.expected_result_at_max,
  );
  const probablyReady = isProbablyReady(row);
  const countdown = expectedCountdown(row);
  const destWarning = trackingDestinationWarning({
    labName: row.lab_name,
    labPanel: row.lab_panel,
    trackingStatus: row.tracking_status,
    trackingLocation: row.tracking_location,
  });
  const trackingMeta = row.tracking_status
    ? TRACKING_BADGE[row.tracking_status]
    : null;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(row);
      }}
      className={`flex w-full gap-2 rounded-md border px-1.5 py-1 text-left transition-colors hover:bg-slate-50 ${
        probablyReady
          ? "border-blue-300 bg-blue-50"
          : counts.openAttempts > 0
            ? attemptCardClasses(counts.openAttempts)
            : isLaggard
              ? "border-yellow-200 bg-yellow-50/40"
              : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[11.5px] font-medium leading-tight text-zinc-800">
          {labLabel}
        </p>
        {row.collection_date || expected || row.tracking_number ? (
          <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-400">
            {row.collection_date ? (
              <span title="Collection date">
                Drawn {formatShortDate(row.collection_date)}
              </span>
            ) : null}
            {expected ? <span>↳ {expected}</span> : null}
            {row.tracking_number ? (
              <span className="truncate">TRK {row.tracking_number}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {trackingMeta ? (
          <RailChip
            className={trackingMeta.className}
            title={
              trackingMeta.label +
              (row.tracking_location ? ` · ${row.tracking_location}` : "") +
              (row.tracking_status_detail ? ` — ${row.tracking_status_detail}` : "")
            }
          >
            {trackingMeta.label}
          </RailChip>
        ) : row.tracking_status ? (
          <RailChip className={CHIP.muted}>{row.tracking_status}</RailChip>
        ) : null}
        {probablyReady ? (
          <RailChip className={CHIP.state} title="Likely ready — check lab portal">
            ready?
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
        {staleness.stale ? (
          <RailChip
            className={CHIP.caution}
            title={`No progress in ${staleness.daysSinceProgress} days`}
          >
            {staleness.daysSinceProgress}d
          </RailChip>
        ) : null}
      </div>
    </button>
  );
}

export function PatientCard({
  group,
  counts,
}: {
  group: PatientGroup;
  counts?: Record<string, CardCounts>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeRow, setActiveRow] = useState<LabCase | null>(null);

  function openLabDetail(row: LabCase) {
    setActiveRow(row);
    // Defer .showModal() until the dialog has the new row rendered to avoid
    // a flash of the previous case's detail on rapid lab-switches.
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function closeDialog() {
    dialogRef.current?.close();
    setActiveRow(null);
  }

  // ESC closes via native dialog; clear local state when it does.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    function onClose() {
      setActiveRow(null);
    }
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  // The earliest-step lab is the patient's bottleneck — highlight it so the
  // operator can see at a glance which lab is holding the patient back.
  let laggardId: string | null = null;
  let laggardSteps = Infinity;
  for (const c of group.cases) {
    const n = completedStepCount(c);
    if (n < laggardSteps) {
      laggardSteps = n;
      laggardId = c.id;
    }
  }

  // Most-recent updated_at across all cases; surfaced as "Updated Xh ago"
  // so the patient card mirrors the per-case freshness indicator.
  const lastUpdated = group.cases.reduce<string>((acc, c) => {
    return !acc || c.updated_at > acc ? c.updated_at : acc;
  }, "");

  return (
    <>
      <div className="rounded-md border border-zinc-200 bg-white p-1.5 shadow-sm transition-shadow hover:shadow">
        <div className="-mx-0.5 -mt-0.5 mb-1 flex items-baseline gap-1.5">
          <Link
            href={`/labs/patients/${encodeURIComponent(group.patientEmail)}`}
            className="flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded px-1 py-0.5 transition-colors hover:bg-zinc-50"
          >
            <h4 className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight text-zinc-900">
              {formatPersonName(group.patientName)}
            </h4>
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
              {group.cases.length} lab{group.cases.length === 1 ? "" : "s"}
            </span>
          </Link>
          <ManageLabsButton
            patientName={group.patientName}
            patientEmail={group.patientEmail}
            cases={group.cases}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          {group.cases.map((c) => (
            <LabRow
              key={c.id}
              row={c}
              onOpen={openLabDetail}
              isLaggard={c.id === laggardId && group.cases.length > 1}
              counts={counts?.[c.id] ?? ZERO_COUNTS}
            />
          ))}
        </div>

        {lastUpdated ? (
          <p className="mt-1 text-[9.5px] text-zinc-400">
            <RelativeTime iso={lastUpdated} />
          </p>
        ) : null}
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
                // Fresh row by id so an in-dialog edit reflects immediately
                // (router.refresh updates group.cases); activeRow is the pointer.
                row={group.cases.find((c) => c.id === activeRow.id) ?? activeRow}
                initialOpenAttempts={counts?.[activeRow.id]?.openAttempts ?? 0}
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
    </>
  );
}
