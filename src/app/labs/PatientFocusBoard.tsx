"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  type ColumnKey,
  getColumnFor,
} from "@/lib/columns";
import { searchPatients, type PatientSuggestion } from "./patient-search-action";
import { CaseDetail } from "./CaseDetail";

/**
 * Single-patient focused kanban. Replaces the old "By patient" grid view —
 * the user explicitly wanted patient lookup, not a wall of every patient.
 *
 * Two modes:
 *   • picker: search box + suggestion list when no patient is selected.
 *   • focused: that patient's labs grouped by step column (7 active columns
 *     + a "Previous labs" column for archived).
 */
type Mode = { kind: "picker" } | { kind: "focused"; email: string };

type FocusedCase = LabCase & { archived: boolean };

const FOCUS_COLUMNS: Array<{ key: ColumnKey | "archived"; label: string }> = [
  ...COLUMN_ORDER.map((c) => ({ key: c, label: COLUMN_LABEL[c] })),
  { key: "archived" as const, label: "Previous labs" },
];

export function PatientFocusBoard({
  initialEmail,
  initialCases,
  initialName,
}: {
  initialEmail: string | null;
  initialCases: FocusedCase[];
  initialName: string | null;
}) {
  const mode: Mode = initialEmail
    ? { kind: "focused", email: initialEmail }
    : { kind: "picker" };

  if (mode.kind === "picker") {
    return <PatientPicker />;
  }
  return (
    <FocusedView
      email={mode.email}
      cases={initialCases}
      patientName={initialName ?? mode.email}
    />
  );
}

function PatientPicker() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<PatientSuggestion[]>([]);
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const r = await searchPatients({ query: q, limit: 15 });
      if (r.ok) setSuggestions(r.data ?? []);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  function pick(emailLower: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("patient", emailLower);
    params.delete("q");
    startTransition(() => {
      router.replace(`/labs?${params.toString()}`);
    });
  }

  return (
    <div className="mx-auto mt-12 max-w-xl">
      <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-900">Look up a patient</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Type a name or email to see every lab they have on file — active,
          partial, results in, and previously closed.
        </p>
        <input
          autoFocus
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Sam Smith or sam@example.com"
          className="mt-3 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
        />
        {q.trim().length >= 2 && suggestions.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">No matches.</p>
        ) : null}
        {suggestions.length > 0 ? (
          <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {suggestions.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => pick(s.key)}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50"
                >
                  <div className="font-medium text-zinc-900">
                    {s.name ?? s.email ?? s.key}
                  </div>
                  {s.email ? (
                    <div className="text-xs text-zinc-500">{s.email}</div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function FocusedView({
  email,
  cases,
  patientName,
}: {
  email: string;
  cases: FocusedCase[];
  patientName: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeCase, setActiveCase] = useState<FocusedCase | null>(null);

  function clearPatient() {
    const u = new URL(window.location.href);
    u.searchParams.delete("patient");
    router.replace(u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : ""));
  }

  function open(c: FocusedCase) {
    setActiveCase(c);
    queueMicrotask(() => dialogRef.current?.showModal());
  }

  function close() {
    dialogRef.current?.close();
    setActiveCase(null);
  }

  // Group cases per column. Archived overrides the step-derived column.
  const grouped: Record<string, FocusedCase[]> = {};
  for (const c of FOCUS_COLUMNS) grouped[c.key] = [];
  for (const c of cases) {
    const key = c.archived ? "archived" : getColumnFor(c);
    grouped[key].push(c);
  }

  const total = cases.length;
  const active = cases.filter((c) => !c.archived).length;
  const archived = total - active;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">{patientName}</h2>
          <p className="text-[11px] text-zinc-500">
            {email} · {total} lab{total === 1 ? "" : "s"}
            {archived > 0
              ? ` (${active} active, ${archived} previous)`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={clearPatient}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          ← Look up another patient
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 lg:flex-1 lg:min-h-0">
        {FOCUS_COLUMNS.map((col) => {
          const items = grouped[col.key];
          return (
            <section
              key={col.key}
              className="kanban-col flex flex-col p-1.5 lg:min-h-0"
              data-col={col.key}
            >
              <header className="flex items-center justify-between px-1.5 py-1">
                <h3 className="col-head-title">{col.label}</h3>
                <span className="col-head-count">{items.length}</span>
              </header>
              <div className="flex min-h-[40px] flex-col gap-1.5 p-0.5 lg:flex-1 lg:overflow-y-auto">
                {items.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
                ) : (
                  items.map((c) => <FocusLabCard key={c.id} row={c} onOpen={() => open(c)} />)
                )}
              </div>
            </section>
          );
        })}
      </div>

      <dialog
        ref={dialogRef}
        className="w-full max-w-3xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {activeCase ? (
          <div className="flex max-h-[88dvh] flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">
                  {activeCase.patient_name}
                </h2>
                <p className="text-xs text-zinc-500">
                  {activeCase.lab_name}
                  {activeCase.lab_panel ? ` · ${activeCase.lab_panel}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-5">
              <CaseDetail row={activeCase} />
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}

function FocusLabCard({ row, onOpen }: { row: FocusedCase; onOpen: () => void }) {
  const labLabel = row.lab_panel
    ? `${row.lab_name} · ${row.lab_panel}`
    : row.lab_name;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 rounded-md border border-zinc-200 bg-white p-1.5 text-left shadow-sm transition-shadow hover:shadow"
    >
      <p className="truncate text-[12px] font-medium leading-tight text-zinc-900">
        {labLabel}
      </p>
      <p className="truncate text-[10.5px] text-zinc-500">
        {row.collection_date ? `Drawn ${row.collection_date}` : "No collection date"}
        {row.archived ? " · archived" : ""}
      </p>
    </button>
  );
}
