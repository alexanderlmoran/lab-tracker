"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  completedStepCount,
  getCaseStaleness,
  getColumnFor,
  type PatientGroup,
  stepIsComplete,
} from "@/lib/columns";
import { CaseDetail } from "./CaseDetail";

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

function ProgressDots({ row }: { row: LabCase }) {
  return (
    <div className="flex items-center gap-[3px]">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
        const filled = stepIsComplete(row, n as 1);
        const skipped = !row.partial_expected && (n === 2 || n === 3);
        return (
          <span
            key={n}
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${
              skipped
                ? "bg-zinc-200"
                : filled
                  ? "bg-zinc-900"
                  : "bg-zinc-300"
            }`}
          />
        );
      })}
    </div>
  );
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

const TRACKING_BADGE: Record<string, { label: string; className: string }> = {
  pre_transit: { label: "Pre-transit", className: "bg-zinc-100 text-zinc-700" },
  in_transit: { label: "In transit", className: "bg-blue-100 text-blue-800" },
  out_for_delivery: {
    label: "Out for delivery",
    className: "bg-indigo-100 text-indigo-800",
  },
  delivered: { label: "Delivered", className: "bg-emerald-100 text-emerald-800" },
  exception: { label: "Exception", className: "bg-rose-100 text-rose-800" },
  returned: { label: "Returned", className: "bg-rose-100 text-rose-800" },
  unknown: { label: "Unknown", className: "bg-zinc-100 text-zinc-500" },
};

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
}: {
  row: LabCase;
  onOpen: (row: LabCase) => void;
  isLaggard: boolean;
}) {
  const done = completedStepCount(row);
  const staleness = getCaseStaleness(row);
  const labLabel = row.lab_panel
    ? `${row.lab_name} · ${row.lab_panel}`
    : row.lab_name;
  const expected = formatExpectedRange(
    row.expected_result_at_min,
    row.expected_result_at_max,
  );
  const probablyReady = isProbablyReady(row);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(row);
      }}
      className={`flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-zinc-50 ${
        probablyReady
          ? "border-purple-300 bg-purple-50"
          : isLaggard
            ? "border-amber-200 bg-amber-50/40"
            : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 break-words text-[12px] font-medium leading-tight text-zinc-800">
          {labLabel}
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
          {done}/9
        </span>
      </div>
      {probablyReady ? (
        <p className="text-[10px] font-medium uppercase tracking-wide text-purple-700">
          ↻ Likely ready — check lab portal
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <ProgressDots row={row} />
        {staleness.stale ? (
          <span
            title={`No progress in ${staleness.daysSinceProgress} days`}
            className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-800"
          >
            {staleness.daysSinceProgress}d
          </span>
        ) : null}
      </div>
      {(row.tracking_number || expected || row.tracking_status) ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-400">
          {row.tracking_status ? (
            <span
              className={`rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                TRACKING_BADGE[row.tracking_status]?.className ?? "bg-zinc-100 text-zinc-500"
              }`}
              title={row.tracking_status_detail ?? undefined}
            >
              {TRACKING_BADGE[row.tracking_status]?.label ?? row.tracking_status}
              {row.tracking_location ? ` · ${row.tracking_location}` : ""}
            </span>
          ) : null}
          {row.tracking_number ? <span>TRK {row.tracking_number}</span> : null}
          {expected ? <span>↳ {expected}</span> : null}
        </div>
      ) : null}
    </button>
  );
}

export function PatientCard({ group }: { group: PatientGroup }) {
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
      <div className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm transition-shadow hover:shadow">
        <Link
          href={`/labs/patients/${encodeURIComponent(group.patientEmail)}`}
          className="-mx-1 -mt-1 mb-2 block rounded px-1 py-1 transition-colors hover:bg-zinc-50"
        >
          <h4 className="break-words text-sm font-medium leading-tight text-zinc-900">
            {group.patientName}
          </h4>
          <p className="truncate text-[11px] text-zinc-500">
            {group.cases.length} lab{group.cases.length === 1 ? "" : "s"}
            {" · "}
            {group.patientEmail}
          </p>
        </Link>

        <div className="flex flex-col gap-1">
          {group.cases.map((c) => (
            <LabRow
              key={c.id}
              row={c}
              onOpen={openLabDetail}
              isLaggard={c.id === laggardId && group.cases.length > 1}
            />
          ))}
        </div>

        {lastUpdated ? (
          <p className="mt-2 text-[10px] text-zinc-400">
            Last update <RelativeTime iso={lastUpdated} />
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
                  {activeRow.patient_name}
                </h2>
                <p className="text-xs text-zinc-500">
                  {activeRow.lab_name}
                  {activeRow.lab_panel ? ` · ${activeRow.lab_panel}` : ""}
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
              <CaseDetail row={activeRow} />
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
