"use client";

import { useEffect, useState, useTransition } from "react";
import { formatPersonName, formatShortDate } from "@/lib/format";
import {
  findDuplicateGroups,
  resolveDuplicates,
  type DuplicateGroup,
} from "../actions";

// Settings → Duplicates. Surfaces genuine duplicate rows (same patient + lab +
// panel, ≥2 non-deleted) so staff can keep one and soft-delete the rest. Every
// removal is an explicit click; nothing is auto-deleted. "high" confidence =
// the members share a tracking # / collection date (same physical order);
// "review" = they differ (could be a legit repeat — check the dates first).
export function DuplicatesPanel() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [keepBy, setKeepBy] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, number>>({});
  const [loading, startLoad] = useTransition();
  const [, startResolve] = useTransition();

  function load() {
    setError(null);
    startLoad(async () => {
      const r = await findDuplicateGroups();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setGroups(r.data?.groups ?? []);
      setKeepBy(
        Object.fromEntries((r.data?.groups ?? []).map((g) => [g.key, g.suggestedKeepId])),
      );
    });
  }
  useEffect(load, []);

  function removeGroup(g: DuplicateGroup) {
    const keepId = keepBy[g.key] ?? g.suggestedKeepId;
    const removeIds = g.members.map((m) => m.id).filter((id) => id !== keepId);
    if (removeIds.length === 0) return;
    if (
      !confirm(
        `Remove ${removeIds.length} duplicate${removeIds.length === 1 ? "" : "s"} of ` +
          `${formatPersonName(g.patientName)} — ${g.members[0].labLabel}?\n\n` +
          `Keeps 1, soft-deletes the rest (recoverable from Settings → Deleted).`,
      )
    ) {
      return;
    }
    setError(null);
    setBusyKey(g.key);
    startResolve(async () => {
      const r = await resolveDuplicates({ keepId, removeIds });
      setBusyKey(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone((d) => ({ ...d, [g.key]: r.data?.removed ?? removeIds.length }));
      setGroups((gs) => (gs ?? []).filter((x) => x.key !== g.key));
    });
  }

  const totalRemoved = Object.values(done).reduce((s, n) => s + n, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? "Scanning…" : "Rescan"}
        </button>
        {groups ? (
          <span className="text-[12px] text-zinc-500">
            {groups.length} duplicate group{groups.length === 1 ? "" : "s"}
            {totalRemoved > 0 ? ` · ${totalRemoved} removed this session` : ""}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </p>
      ) : null}

      {groups && groups.length === 0 ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
          No duplicate cases found. 🎉
        </p>
      ) : null}

      {(groups ?? []).map((g) => {
        const keepId = keepBy[g.key] ?? g.suggestedKeepId;
        const removeCount = g.members.length - 1;
        return (
          <div key={g.key} className="rounded-md border border-zinc-200">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-zinc-900">
                  {formatPersonName(g.patientName)} — {g.members[0].labLabel}
                </p>
                <p className="text-[11px] text-zinc-500">{g.patientEmail}</p>
              </div>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  g.confidence === "high"
                    ? "bg-rose-100 text-rose-700"
                    : "bg-amber-100 text-amber-700"
                }`}
                title={
                  g.confidence === "high"
                    ? "Members share a tracking # or collection date — almost certainly one order"
                    : "Members differ — could be a legitimate repeat; check the dates before removing"
                }
              >
                {g.confidence === "high" ? "likely dup" : "review"}
              </span>
            </div>

            <div className="divide-y divide-zinc-100">
              {g.members.map((m) => (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-zinc-50"
                >
                  <input
                    type="radio"
                    name={`keep-${g.key}`}
                    checked={keepId === m.id}
                    onChange={() => setKeepBy((k) => ({ ...k, [g.key]: m.id }))}
                    className="shrink-0"
                  />
                  <span className="w-14 shrink-0 text-[10px] font-medium uppercase text-zinc-400">
                    {keepId === m.id ? "keep" : "remove"}
                  </span>
                  <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
                    {m.columnLabel}
                  </span>
                  <span className="text-zinc-600">
                    {m.collectionDate ? `Collected ${formatShortDate(m.collectionDate)}` : "no date"}
                  </span>
                  {m.tracking ? (
                    <span className="truncate font-mono text-[10px] text-zinc-400">
                      {m.tracking}
                    </span>
                  ) : null}
                  {m.archived ? (
                    <span className="shrink-0 text-[10px] text-zinc-400">archived</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                    {m.stepsDone} step{m.stepsDone === 1 ? "" : "s"}
                  </span>
                </label>
              ))}
            </div>

            <div className="flex items-center justify-end border-t border-zinc-100 px-3 py-2">
              <button
                type="button"
                onClick={() => removeGroup(g)}
                disabled={busyKey === g.key || removeCount === 0}
                className="rounded-md border border-rose-300 bg-white px-3 py-1 text-[12px] font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                {busyKey === g.key
                  ? "Removing…"
                  : `Remove ${removeCount} duplicate${removeCount === 1 ? "" : "s"} (keep 1)`}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
