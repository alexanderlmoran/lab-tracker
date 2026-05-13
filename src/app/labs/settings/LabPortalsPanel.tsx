"use client";

import { useMemo, useState, useTransition } from "react";
import {
  deleteLabPortal,
  seedLabPortalsFromCode,
  upsertLabPortal,
  type LabPortalRow,
} from "./actions";

export function LabPortalsPanel({ portals }: { portals: LabPortalRow[] }) {
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LabPortalRow | "new" | null>(null);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return portals;
    return portals.filter((p) =>
      `${p.lab_key} ${p.label} ${p.url} ${p.audience ?? ""}`
        .toLowerCase()
        .includes(f),
    );
  }, [portals, filter]);

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by lab, label, URL…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
        />
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          + Add portal
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await seedLabPortalsFromCode();
              if (!r.ok) setError(r.error);
            })
          }
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          title="Insert any portals from the code constant that aren't already in the database. Safe to re-run."
        >
          {pending ? "Seeding…" : "Seed from code"}
        </button>
      </div>

      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {portals.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
          No portals saved yet. Click <strong>Seed from code</strong> to import
          the defaults, or <strong>Add portal</strong> to start from scratch.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="px-2 py-2">Lab key</th>
              <th className="px-2 py-2">Label</th>
              <th className="px-2 py-2">URL</th>
              <th className="px-2 py-2">Audience</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-t border-zinc-100 align-top">
                <td className="px-2 py-2 text-zinc-900">{p.lab_key}</td>
                <td className="px-2 py-2 text-zinc-700">{p.label}</td>
                <td className="px-2 py-2 text-zinc-500">
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline-offset-2 hover:underline"
                  >
                    {p.url}
                  </a>
                </td>
                <td className="px-2 py-2 text-zinc-600">
                  {p.audience ?? "—"}
                </td>
                <td className="px-2 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Open ↗
                    </a>
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (!confirm(`Delete "${p.label}"?`)) return;
                        startTransition(async () => {
                          setError(null);
                          const r = await deleteLabPortal({ id: p.id });
                          if (!r.ok) setError(r.error);
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
          portal={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function EditDialog({
  portal,
  onClose,
}: {
  portal: LabPortalRow | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      setError(null);
      const r = await upsertLabPortal(formData);
      if (!r.ok) setError(r.error);
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
            {portal ? "Edit portal" : "Add portal"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-900"
          >
            Close
          </button>
        </div>
        {portal ? <input type="hidden" name="id" value={portal.id} /> : null}
        <Field
          name="lab_key"
          label="Lab key (must match the lab_name on cases — e.g. Cyrex, Vibrant)"
          required
          defaultValue={portal?.lab_key ?? ""}
        />
        <Field
          name="label"
          label="Button label"
          required
          defaultValue={portal?.label ?? ""}
        />
        <Field
          name="url"
          label="Portal URL (https://…)"
          type="url"
          required
          defaultValue={portal?.url ?? ""}
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">Audience</span>
            <select
              name="audience"
              defaultValue={portal?.audience ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900"
            >
              <option value="">— (either)</option>
              <option value="provider">Provider</option>
              <option value="patient">Patient</option>
            </select>
          </label>
          <Field
            name="sort_order"
            label="Sort order"
            type="number"
            defaultValue={portal?.sort_order ?? 0}
          />
        </div>
        <Field
          name="notes"
          label="Notes (optional)"
          defaultValue={portal?.notes ?? ""}
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

function Field({
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
