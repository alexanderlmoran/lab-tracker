"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  LAB_BOARD_COLUMN_ORDER,
  type ColumnKey,
  completedStepCount,
  expectedCountdown,
  getCaseStaleness,
  getCaseWorkflow,
  getColumnFor,
  getWorkflowSteps,
} from "@/lib/columns";
import { trackingDestinationWarning } from "@/lib/labs/catalog";
import { CaseDetail } from "./CaseDetail";
import { formatPersonName, formatShortDate } from "@/lib/format";

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
}: {
  row: LabCase;
  onOpen: (row: LabCase) => void;
}) {
  const done = completedStepCount(row);
  const totalSteps = getWorkflowSteps(getCaseWorkflow(row)).length;
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
  const labLabel = row.lab_panel
    ? `${row.lab_name} · ${row.lab_panel}`
    : row.lab_name;

  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className={`flex w-full flex-col gap-0.5 rounded-md border bg-white p-1.5 text-left shadow-sm transition-shadow hover:shadow ${
        probablyReady ? "border-purple-300 bg-purple-50" : "border-zinc-200"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] font-medium leading-tight text-zinc-900">
          {labLabel}
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">{done}/{totalSteps}</span>
      </div>
      <p className="truncate text-[11px] text-zinc-500">{formatPersonName(row.patient_name)}</p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {countdown ? (
            <span
              title={
                countdown.tone === "overdue"
                  ? `Expected by ${formatShortDate(row.expected_result_at_max)} — past`
                  : `Expected by ${formatShortDate(row.expected_result_at_max)}`
              }
              className={`rounded px-1 py-0.5 text-[9px] font-medium tabular-nums tracking-wide ${
                countdown.tone === "overdue"
                  ? "bg-rose-100 text-rose-700"
                  : countdown.tone === "due"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-zinc-100 text-zinc-600"
              }`}
            >
              {countdown.label}
            </span>
          ) : null}
          {destWarning ? (
            <span
              title={destWarning}
              className="rounded bg-orange-100 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-orange-800"
            >
              wrong city?
            </span>
          ) : null}
          {probablyReady ? (
            <span
              title="Likely ready — check lab portal"
              className="rounded bg-purple-100 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-purple-700"
            >
              ready?
            </span>
          ) : null}
          {row.tracking_status ? (
            <span
              className={`rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                TRACKING_BADGE[row.tracking_status]?.className ??
                "bg-zinc-100 text-zinc-500"
              }`}
              title={row.tracking_status_detail ?? undefined}
            >
              {TRACKING_BADGE[row.tracking_status]?.label ?? row.tracking_status}
            </span>
          ) : null}
          {stale.stale ? (
            <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-800">
              {stale.daysSinceProgress}d
            </span>
          ) : null}
        </div>
      </div>

      {(row.tracking_number || expected) ? (
        <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-400">
          {expected ? <span>↳ {expected}</span> : null}
          {row.tracking_number ? <span className="truncate">TRK {row.tracking_number}</span> : null}
        </div>
      ) : null}
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
  return (
    <section
      className="kanban-col flex min-w-0 flex-1 basis-0 flex-col p-1.5 lg:min-h-0"
      data-col={col}
    >
      <header className="flex items-center justify-between px-1.5 py-1">
        <h3 className="col-head-title">{COLUMN_LABEL[col]}</h3>
        <span className="col-head-count">{count}</span>
      </header>
      <div className="flex min-h-[40px] flex-col gap-1.5 p-0.5 lg:flex-1 lg:overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

function LabFilterBar({
  probablyReadyOnly,
  staleOnly,
  onToggleProbablyReady,
  onToggleStale,
  total,
  filtered,
}: {
  probablyReadyOnly: boolean;
  staleOnly: boolean;
  onToggleProbablyReady: () => void;
  onToggleStale: () => void;
  total: number;
  filtered: number;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onToggleProbablyReady}
        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          probablyReadyOnly
            ? "border-purple-300 bg-purple-50 text-purple-800"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Likely ready
      </button>
      <button
        type="button"
        onClick={onToggleStale}
        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          staleOnly
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Stale only
      </button>
      <span className="ml-auto text-xs text-zinc-500">
        {filtered === total
          ? `${total} lab${total === 1 ? "" : "s"}`
          : `${filtered} of ${total} labs`}
      </span>
    </div>
  );
}

export function LabKanbanBoard({ rows }: { rows: LabCase[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const probablyReadyOnly = searchParams.get("ready") === "1";
  const staleOnly = searchParams.get("stale") === "1";

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `/labs?${qs}` : "/labs");
  }

  const filtered = useMemo(() => {
    let list = rows;
    if (probablyReadyOnly) list = list.filter(isProbablyReady);
    if (staleOnly) list = list.filter((r) => getCaseStaleness(r).stale);
    return list;
  }, [rows, probablyReadyOnly, staleOnly]);

  const grouped: Record<ColumnKey, LabCase[]> = {
    untouched: [],
    sample_sent: [],
    partial_results: [],
    complete_results: [],
    rof_scheduled: [],
    rof_done: [],
    closed: [],
    completed: [],
  };
  for (const r of filtered) grouped[getColumnFor(r)].push(r);
  for (const col of LAB_BOARD_COLUMN_ORDER) {
    grouped[col].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeRow, setActiveRow] = useState<LabCase | null>(null);

  function openLabDetail(row: LabCase) {
    setActiveRow(row);
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
      <LabFilterBar
        probablyReadyOnly={probablyReadyOnly}
        staleOnly={staleOnly}
        onToggleProbablyReady={() =>
          updateParam("ready", probablyReadyOnly ? null : "1")
        }
        onToggleStale={() => updateParam("stale", staleOnly ? null : "1")}
        total={rows.length}
        filtered={filtered.length}
      />

      <div className="flex flex-row flex-nowrap gap-1.5 pb-2 lg:flex-1 lg:min-h-0">
        {LAB_BOARD_COLUMN_ORDER.map((col) => {
          const colRows = grouped[col];
          return (
            <StaticColumn key={col} col={col} count={colRows.length}>
              {colRows.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
              ) : (
                colRows.map((row) => (
                  <LabCard key={row.id} row={row} onOpen={openLabDetail} />
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
    </div>
  );
}
