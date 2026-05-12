"use client";

import { useMemo, useState, useTransition } from "react";
import {
  deleteLab,
  seedLabsCatalogFromCode,
  upsertLab,
  type LabsCatalogRow,
} from "./actions";

export function LabsCatalogPanel({ labs }: { labs: LabsCatalogRow[] }) {
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LabsCatalogRow | "new" | null>(null);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return labs;
    return labs.filter((l) =>
      [l.name, l.provider, l.panel ?? ""].some((s) =>
        s.toLowerCase().includes(f),
      ),
    );
  }, [labs, filter]);

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by lab name, provider, panel…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
        />
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          + Add lab
        </button>
        {labs.length === 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await seedLabsCatalogFromCode();
                if (!res.ok) setError(res.error);
              })
            }
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {pending ? "Seeding…" : "Seed from code catalog"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {labs.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
          No labs in the database yet. Click <strong>Seed from code catalog</strong>{" "}
          to import the labs defined in <code>src/lib/labs/catalog.ts</code>.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="px-2 py-2">Lab</th>
              <th className="px-2 py-2">Provider</th>
              <th className="px-2 py-2">Panel</th>
              <th className="px-2 py-2">Turnaround</th>
              <th className="px-2 py-2">Partial?</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((lab) => (
              <tr
                key={lab.id}
                className={`border-t border-zinc-100 ${
                  lab.retired ? "opacity-60" : ""
                }`}
              >
                <td className="px-2 py-2 text-zinc-900">{lab.name}</td>
                <td className="px-2 py-2 text-zinc-600">{lab.provider}</td>
                <td className="px-2 py-2 text-zinc-600">{lab.panel ?? "—"}</td>
                <td className="px-2 py-2 text-zinc-600">
                  {formatTurnaround(lab.turnaround_days_min, lab.turnaround_days_max)}
                </td>
                <td className="px-2 py-2 text-zinc-600">
                  {lab.partial_expected ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800">
                      yes
                    </span>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(lab)}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (!confirm(`Delete "${lab.name}" from the catalog?`)) return;
                        startTransition(async () => {
                          setError(null);
                          const res = await deleteLab({ id: lab.id });
                          if (!res.ok) setError(res.error);
                        });
                      }}
                      className="rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing ? (
        <EditDialog
          lab={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function formatTurnaround(min: number | null, max: number | null): string {
  if (min == null && max == null) return "—";
  if (min != null && max != null && min !== max) return `${min}–${max} days`;
  return `${max ?? min} days`;
}

function EditDialog({
  lab,
  onClose,
}: {
  lab: LabsCatalogRow | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      setError(null);
      const res = await upsertLab(formData);
      if (!res.ok) setError(res.error);
      else onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-3 rounded-lg bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold text-zinc-900">
            {lab ? "Edit lab" : "Add lab"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-900"
          >
            Close
          </button>
        </div>
        {lab ? <input type="hidden" name="id" value={lab.id} /> : null}
        <DialogField
          name="name"
          label="Display name"
          required
          defaultValue={lab?.name ?? ""}
        />
        <div className="grid grid-cols-2 gap-3">
          <DialogField
            name="provider"
            label="Provider"
            required
            defaultValue={lab?.provider ?? ""}
          />
          <DialogField
            name="panel"
            label="Panel (optional)"
            defaultValue={lab?.panel ?? ""}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <DialogField
            name="turnaround_days_min"
            label="Turnaround min (days)"
            type="number"
            min={0}
            defaultValue={lab?.turnaround_days_min ?? ""}
          />
          <DialogField
            name="turnaround_days_max"
            label="Turnaround max (days)"
            type="number"
            min={0}
            defaultValue={lab?.turnaround_days_max ?? ""}
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              name="partial_expected"
              defaultChecked={lab?.partial_expected ?? false}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Partial results expected
            <span className="text-[11px] text-zinc-500">
              (pre-ticks the partial flag on new cases for this lab)
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              name="retired"
              defaultChecked={lab?.retired ?? false}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Retired (hidden from lab pickers)
          </label>
        </div>
        <DialogField
          name="notes"
          label="Notes (optional)"
          defaultValue={lab?.notes ?? ""}
        />
        {error ? (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DialogField({
  name,
  label,
  ...rest
}: { name: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-700">{label}</span>
      <input
        {...rest}
        name={name}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
      />
    </label>
  );
}
