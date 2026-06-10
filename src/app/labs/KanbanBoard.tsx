"use client";

import { useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  PATIENT_COLUMN_LABEL,
  PATIENT_COLUMN_ORDER,
  type PatientColumnKey,
  getPatientColumnForPatient,
  groupByPatient,
  type PatientGroup,
} from "@/lib/columns";
import { PatientCard } from "./PatientCard";
import {
  bulkArchive,
  bulkDelete,
  bulkSetStepCompleted,
  mergeCasesByDate,
  mergePatients,
} from "./actions";
import { formatPersonName } from "@/lib/format";
import type { CardCounts } from "./card-counts";

const BULK_STEP_OPTIONS: Array<{ step: 1 | 4 | 5 | 6 | 7; label: string }> = [
  { step: 1, label: "Sample sent" },
  { step: 4, label: "Complete results received" },
  { step: 5, label: "Complete uploaded" },
  { step: 6, label: "ROF scheduled" },
  { step: 7, label: "ROF completed" },
];

function StaticColumn({
  col,
  count,
  children,
}: {
  col: PatientColumnKey;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="kanban-col flex flex-col p-1.5 lg:min-h-0"
      data-col={col}
    >
      <header className="flex items-center justify-between px-1.5 py-1">
        <h3 className="col-head-title">{PATIENT_COLUMN_LABEL[col]}</h3>
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
  counts,
}: {
  group: PatientGroup;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (caseIds: string[]) => void;
  counts?: Record<string, CardCounts>;
}) {
  if (!selectMode) return <PatientCard group={group} counts={counts} />;

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
        <PatientCard group={group} counts={counts} />
      </div>
    </div>
  );
}

export function KanbanBoard({
  rows,
  counts,
}: {
  rows: LabCase[];
  counts?: Record<string, CardCounts>;
}) {
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

  function onBulkAdvanceStep(step: number, stepLabel: string) {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Mark "${stepLabel}" complete on ${selected.size} case${
          selected.size === 1 ? "" : "s"
        }?\n\nNo patient or staff emails will fire — this is administrative.`,
      )
    )
      return;
    startBulk(async () => {
      const r = await bulkSetStepCompleted({
        caseIds: [...selected],
        step,
        completed: true,
      });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  // The selected cases, plus the distinct patient identities among them — used
  // to seed the merge prompts so staff don't retype an email/name.
  const selectedRows = rows.filter((r) => selected.has(r.id));
  function distinctIdentities() {
    const seen = new Map<string, { email: string; name: string }>();
    for (const r of selectedRows) {
      const key = r.patient_email.trim().toLowerCase();
      if (!seen.has(key))
        seen.set(key, { email: r.patient_email, name: r.patient_name });
    }
    return [...seen.values()];
  }

  // #17 Merge patients: reassign every selected case onto ONE identity so
  // duplicate/misspelled patients collapse into a single group. Defaults the
  // canonical email to the first selected patient; staff confirm/override.
  function onMergePatients() {
    if (selected.size === 0) return;
    const ids = distinctIdentities();
    if (ids.length < 2) {
      alert("Select cases from two or more different patients to merge them.");
      return;
    }
    const list = ids.map((i) => `• ${formatPersonName(i.name)} <${i.email}>`).join("\n");
    const email = prompt(
      `Merge ${selected.size} case(s) from ${ids.length} patients into ONE.\n\n${list}\n\nKeep which email? (everything is reassigned to it)`,
      ids[0].email,
    );
    if (!email) return;
    const match = ids.find((i) => i.email.toLowerCase() === email.trim().toLowerCase());
    const name = (match?.name ?? ids[0].name).trim();
    startBulk(async () => {
      const r = await mergePatients({ caseIds: [...selected], email: email.trim(), name });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  // #17 Merge by date: stamp one collection_date across the selected cases so
  // they read as a single drawn-together batch (patients do 2–7 at a time).
  function onMergeByDate() {
    if (selected.size === 0) return;
    const seed =
      selectedRows.find((r) => r.collection_date)?.collection_date ?? "";
    const date = prompt(
      `Set ONE collection date (YYYY-MM-DD) on ${selected.size} selected case(s) so they group as a single draw:`,
      seed,
    );
    if (!date) return;
    startBulk(async () => {
      const r = await mergeCasesByDate({
        caseIds: [...selected],
        collectionDate: date.trim(),
      });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  const groups = groupByPatient(rows);
  const grouped: Record<PatientColumnKey, PatientGroup[]> = {
    p_new: [],
    p_at_lab: [],
    p_results: [],
    p_done: [],
  };
  for (const g of groups) grouped[getPatientColumnForPatient(g.cases)].push(g);

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

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4 lg:flex-1 lg:min-h-0">
        {PATIENT_COLUMN_ORDER.map((col) => {
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
                    counts={counts}
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
          <select
            onChange={(e) => {
              const step = Number(e.target.value);
              const found = BULK_STEP_OPTIONS.find((o) => o.step === step);
              e.currentTarget.selectedIndex = 0;
              if (found) onBulkAdvanceStep(found.step, found.label);
            }}
            className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <option value="">Advance step…</option>
            {BULK_STEP_OPTIONS.map((opt) => (
              <option key={opt.step} value={opt.step}>
                Mark step {opt.step}: {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onMergePatients}
            className="rounded-full border border-purple-300 bg-white px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50"
            title="Reassign the selected cases onto one patient (collapses duplicate/misspelled patients)"
          >
            Merge patients
          </button>
          <button
            type="button"
            onClick={onMergeByDate}
            className="rounded-full border border-purple-300 bg-white px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50"
            title="Stamp one collection date on the selected cases so they group as a single draw"
          >
            Merge by date
          </button>
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
