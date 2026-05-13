"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LabCase } from "@/lib/types";
import { STEP_BOOLEAN_COLUMNS } from "@/lib/types";
import {
  bulkRestore,
  bulkUnarchive,
  deleteLabCase,
  restoreLabCase,
  unarchiveLabCase,
} from "./actions";

type Mode = "deleted" | "archived";

function progressOf(c: LabCase) {
  return STEP_BOOLEAN_COLUMNS.reduce((n, key) => (c[key] ? n + 1 : n), 0);
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Recovery view for the deleted/archived tabs.
 *
 * Optimistic-removal pattern: visible rows = `rows` (from server) MINUS
 * `pendingRemoved` (IDs the user just acted on). We deliberately do NOT
 * mirror `rows` into state, because the parent can re-render with a stale
 * snapshot during a useTransition window and overwrite our optimistic state —
 * that was the original "row comes back" bug. Once the server refresh
 * confirms the row is gone, we prune the pending set.
 *
 * If a server action fails, we roll back by removing the ID from pending —
 * the row reappears because it's still present in the `rows` prop.
 */
export function BulkRecoveryTable({
  rows,
  mode,
}: {
  rows: LabCase[];
  mode: Mode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingRemoved, setPendingRemoved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Prune pending-removed IDs once the server has confirmed they're gone
  // (i.e., the row is no longer in the fresh `rows` prop). Keeps the set
  // bounded so it can't accumulate stale entries forever.
  useEffect(() => {
    if (pendingRemoved.size === 0) return;
    const stillPresent = new Set(rows.map((r) => r.id));
    let needsUpdate = false;
    const next = new Set<string>();
    for (const id of pendingRemoved) {
      if (stillPresent.has(id)) next.add(id);
      else needsUpdate = true;
    }
    if (needsUpdate) setPendingRemoved(next);
  }, [rows, pendingRemoved]);

  const visibleRows = useMemo(
    () => rows.filter((r) => !pendingRemoved.has(r.id)),
    [rows, pendingRemoved],
  );
  const visibleIds = useMemo(
    () => visibleRows.map((r) => r.id),
    [visibleRows],
  );
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(visibleIds) : new Set());
  }

  function markPending(ids: string[]) {
    setPendingRemoved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  function rollback(ids: string[]) {
    setPendingRemoved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  function runRowAction(row: LabCase, kind: "restore" | "unarchive" | "delete") {
    if (kind === "delete") {
      if (
        !confirm(
          `Permanently move "${row.patient_name}" off this list?\n\nDeleted cases stay recoverable here unless purged.`,
        )
      ) {
        return;
      }
    }
    setError(null);
    markPending([row.id]);
    startTransition(async () => {
      const r =
        kind === "restore"
          ? await restoreLabCase(row.id)
          : kind === "unarchive"
            ? await unarchiveLabCase(row.id)
            : await deleteLabCase(row.id);
      if (!r.ok) {
        setError(r.error ?? "Action failed");
        rollback([row.id]);
        return;
      }
      router.refresh();
    });
  }

  function runBulk() {
    const ids = visibleIds.filter((id) => selected.has(id));
    if (ids.length === 0) return;
    const verb = mode === "deleted" ? "Restore" : "Unarchive";
    if (
      !confirm(`${verb} ${ids.length} case${ids.length === 1 ? "" : "s"}?`)
    ) {
      return;
    }
    setError(null);
    markPending(ids);
    startTransition(async () => {
      const r =
        mode === "deleted"
          ? await bulkRestore({ caseIds: ids })
          : await bulkUnarchive({ caseIds: ids });
      if (!r.ok) {
        setError(r.error ?? "Bulk action failed");
        rollback(ids);
        return;
      }
      router.refresh();
    });
  }

  const isDeleted = mode === "deleted";
  const primaryVerb = isDeleted ? "Restore" : "Unarchive";
  const bulkLabel =
    selected.size > 0
      ? `${primaryVerb} selected (${selected.size})`
      : `${primaryVerb} all`;

  if (visibleRows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-10 text-center">
        <p className="text-sm text-zinc-600">
          {isDeleted ? "No deleted cases." : "No archived cases."}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {isDeleted
            ? "Soft-deleted cases land here. Restore moves them back to the active kanban."
            : "Archived cases land here. Unarchive moves them back to the active kanban."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={(e) => toggleAll(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-zinc-300"
          />
          <div className="text-xs text-zinc-600">
            {selected.size > 0 ? (
              <span>
                <strong className="text-zinc-900">{selected.size}</strong> of{" "}
                {visibleRows.length} selected
              </span>
            ) : (
              <span>
                {visibleRows.length}{" "}
                {visibleRows.length === 1 ? "case" : "cases"}
              </span>
            )}
          </div>
          {selected.size > 0 ? (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              clear
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runBulk}
            disabled={pending || visibleRows.length === 0}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            {pending ? "Working…" : bulkLabel}
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {/* Card list */}
      <ul className="grid gap-2">
        {visibleRows.map((row) => {
          const done = progressOf(row);
          const checked = selected.has(row.id);
          const stampIso = isDeleted ? row.deleted_at : row.archived_at;
          return (
            <li
              key={row.id}
              className={`flex items-center gap-3 rounded-md border bg-white px-3 py-2.5 shadow-sm transition-colors ${
                checked
                  ? "border-emerald-300 bg-emerald-50/40"
                  : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <input
                type="checkbox"
                aria-label={`Select ${row.patient_name}`}
                checked={checked}
                onChange={(e) => toggleOne(row.id, e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-zinc-300"
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="truncate text-sm font-medium text-zinc-900">
                    {row.patient_name}
                  </span>
                  <span className="text-[11px] text-zinc-500">
                    {row.patient_email}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-600">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700">
                    {row.lab_name}
                    {row.lab_panel ? ` · ${row.lab_panel}` : ""}
                  </span>
                  <span>{done}/9 steps</span>
                  {row.tracking_number ? (
                    <span className="text-zinc-500">
                      TRK {row.tracking_number}
                    </span>
                  ) : null}
                  <span className="text-zinc-400">
                    {isDeleted ? "Deleted" : "Archived"}{" "}
                    {formatDate(stampIso)}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => runRowAction(row, isDeleted ? "restore" : "unarchive")}
                  disabled={pending}
                  className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {primaryVerb}
                </button>
                {!isDeleted ? (
                  <button
                    type="button"
                    onClick={() => runRowAction(row, "delete")}
                    disabled={pending}
                    className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
