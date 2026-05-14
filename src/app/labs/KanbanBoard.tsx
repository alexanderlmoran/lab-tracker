"use client";

import { useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  type ColumnKey,
  getColumnForPatient,
  groupByPatient,
  type PatientGroup,
} from "@/lib/columns";
import { PatientCard } from "./PatientCard";
import { bulkArchive, bulkDelete } from "./actions";

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
      className="kanban-col flex flex-col p-1.5 lg:min-h-0"
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

function SelectablePatientCard({
  group,
  selectMode,
  selected,
  onToggleSelect,
}: {
  group: PatientGroup;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (caseIds: string[]) => void;
}) {
  if (!selectMode) return <PatientCard group={group} />;

  // In select mode every card in the group toggles together — bulk actions
  // operate on the patient as a whole. Visual ring uses "all selected" state.
  const groupIds = group.cases.map((c) => c.id);
  const allSelected = groupIds.every((id) => selected.has(id));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggleSelect(groupIds)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSelect(groupIds);
        }
      }}
      className={`relative cursor-pointer rounded-md transition-shadow ${
        allSelected ? "ring-2 ring-blue-500" : "hover:ring-1 hover:ring-zinc-300"
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-2 top-2 z-10 flex h-4 w-4 items-center justify-center rounded border ${
          allSelected
            ? "border-blue-500 bg-blue-500 text-white"
            : "border-zinc-300 bg-white"
        }`}
      >
        {allSelected ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <path
              d="M2 6.5l2.5 2.5L10 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      <div className="pointer-events-none">
        <PatientCard group={group} />
      </div>
    </div>
  );
}

export function KanbanBoard({ rows }: { rows: LabCase[] }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startBulk] = useTransition();

  function toggleSelectGroup(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      if (allIn) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function onBulkArchive() {
    if (selected.size === 0) return;
    if (!confirm(`Archive ${selected.size} selected case(s)?`)) return;
    startBulk(async () => {
      const r = await bulkArchive({ caseIds: [...selected] });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  function onBulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected case(s)? They can be restored.`))
      return;
    startBulk(async () => {
      const r = await bulkDelete({ caseIds: [...selected] });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  const groups = groupByPatient(rows);
  const grouped: Record<ColumnKey, PatientGroup[]> = {
    untouched: [],
    sample_sent: [],
    partial_results: [],
    complete_results: [],
    rof_scheduled: [],
    rof_done: [],
    closed: [],
  };
  for (const g of groups) grouped[getColumnForPatient(g.cases)].push(g);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {selectMode
            ? `${selected.size} case${selected.size === 1 ? "" : "s"} selected`
            : `${groups.length} patient${groups.length === 1 ? "" : "s"} · ${rows.length} lab${rows.length === 1 ? "" : "s"}`}
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setSelected((s) =>
                    s.size === rows.length
                      ? new Set()
                      : new Set(rows.map((r) => r.id)),
                  )
                }
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                {selected.size === rows.length ? "Clear" : "Select all"}
              </button>
              <button
                type="button"
                onClick={exitSelectMode}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              Select multiple
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-7 lg:flex-1 lg:min-h-0">
        {COLUMN_ORDER.map((col) => {
          const colGroups = grouped[col];
          return (
            <StaticColumn key={col} col={col} count={colGroups.length}>
              {colGroups.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
              ) : (
                colGroups.map((g) => (
                  <SelectablePatientCard
                    key={g.patientEmail.toLowerCase()}
                    group={g}
                    selectMode={selectMode}
                    selected={selected}
                    onToggleSelect={toggleSelectGroup}
                  />
                ))
              )}
            </StaticColumn>
          );
        })}
      </div>

      {selectMode && selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-2 shadow-lg">
          <span className="px-2 text-sm font-medium text-zinc-900">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={onBulkArchive}
            className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Archive
          </button>
          <button
            type="button"
            onClick={onBulkDelete}
            className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={exitSelectMode}
            aria-label="Close"
            className="ml-1 rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
