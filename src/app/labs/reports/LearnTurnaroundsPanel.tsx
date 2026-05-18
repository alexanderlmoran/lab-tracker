"use client";

import { useState, useTransition } from "react";
import {
  recomputeCatalogTurnaroundsFromHistory,
  type LearnTurnaroundsResult,
} from "../learn-actions";

export function LearnTurnaroundsPanel() {
  const [result, setResult] = useState<LearnTurnaroundsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const r = await recomputeCatalogTurnaroundsFromHistory();
      if (!r.ok) {
        setError(r.error);
        setResult(null);
        return;
      }
      setResult(r.data ?? null);
    });
  }

  const hasResult = result != null;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            Auto-learn lab turnarounds
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Aggregates observed days between collection_date and step-4
            (results received) per lab. With ≥5 observations, updates
            labs_catalog.turnaround_days_min/max to p25/p75 of the
            observations. Affects future expected-result-by date predictions.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? "Running…" : "Recompute now"}
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {hasResult ? (
        <div className="mt-4 space-y-4">
          <ResultGroup
            title={`Updated (${result.updatedLabs.length})`}
            empty="No lab had enough history to update."
          >
            {result.updatedLabs.length > 0 ? (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-2 py-1 text-left">Lab</th>
                    <th className="px-2 py-1 text-right">N</th>
                    <th className="px-2 py-1 text-right">p25 days</th>
                    <th className="px-2 py-1 text-right">median</th>
                    <th className="px-2 py-1 text-right">p75 days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {result.updatedLabs.map((r) => (
                    <tr key={r.name}>
                      <td className="px-2 py-1 text-zinc-700">{r.name}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.observations}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.daysMin}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-500">
                        {r.daysMedian}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.daysMax}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </ResultGroup>

          {result.insufficientObservations.length > 0 ? (
            <ResultGroup
              title={`Need more data (${result.insufficientObservations.length})`}
            >
              <ul className="text-xs text-zinc-600">
                {result.insufficientObservations.map((r) => (
                  <li key={r.name}>
                    {r.name}: {r.observations} / {r.needed} observations
                  </li>
                ))}
              </ul>
            </ResultGroup>
          ) : null}

          {result.unmappedLabs.length > 0 ? (
            <ResultGroup
              title={`Unmapped to catalog (${result.unmappedLabs.length})`}
            >
              <ul className="text-xs text-zinc-600">
                {result.unmappedLabs.map((r) => (
                  <li key={`${r.rawLabName}-${r.rawPanel ?? ""}`}>
                    {r.rawLabName}
                    {r.rawPanel ? ` · ${r.rawPanel}` : ""} — {r.observations} obs (add a catalog entry to track)
                  </li>
                ))}
              </ul>
            </ResultGroup>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ResultGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
      <h3 className="text-xs font-semibold text-zinc-900">{title}</h3>
      <div className="mt-1">
        {children ?? (empty ? <p className="text-xs text-zinc-500">{empty}</p> : null)}
      </div>
    </div>
  );
}
