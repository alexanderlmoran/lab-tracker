"use client";

import type { LabTurnaroundRow } from "./actions";

/**
 * Actual vs catalog turnaround for every lab+panel that's recorded at
 * least one Complete-result step toggle. Catalog numbers come from
 * labs_catalog (overrides) + code defaults; observed numbers come from
 * lab_events step-4 timestamps minus collection_date.
 *
 * "drift" is positive when p50 turnaround exceeds the catalog's max —
 * the catalog under-estimates, so expected-date predictions on new cases
 * will routinely be wrong. Highlight red so operator notices.
 */
export function TurnaroundPanel({ rows }: { rows: LabTurnaroundRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 bg-white p-4 text-xs text-zinc-500">
        No completed cases yet — once step 4 has been toggled on at least one
        case with a collection date, observed turnarounds will show here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="w-full text-xs">
        <thead className="bg-zinc-50 text-left text-zinc-600">
          <tr>
            <th className="px-3 py-2 font-medium">Lab</th>
            <th className="px-3 py-2 font-medium">Panel</th>
            <th className="px-3 py-2 text-right font-medium" title="Number of completed cases informing this row">
              N
            </th>
            <th className="px-3 py-2 text-right font-medium">Mean</th>
            <th className="px-3 py-2 text-right font-medium" title="Median — half of cases came back within this many days">
              p50
            </th>
            <th className="px-3 py-2 text-right font-medium" title="90th percentile — 9 of 10 cases came back within this many days">
              p90
            </th>
            <th className="px-3 py-2 text-right font-medium">Catalog</th>
            <th className="px-3 py-2 text-right font-medium" title="p50 minus catalog max. Positive = catalog under-estimates real turnaround.">
              Drift
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const catalog =
              r.catalogMin != null && r.catalogMax != null
                ? r.catalogMin === r.catalogMax
                  ? `${r.catalogMin}d`
                  : `${r.catalogMin}–${r.catalogMax}d`
                : "—";
            const driftClass =
              r.drift == null
                ? "text-zinc-400"
                : r.drift > 3
                  ? "text-rose-700 font-medium"
                  : r.drift > 0
                    ? "text-amber-700"
                    : r.drift < -3
                      ? "text-emerald-700"
                      : "text-zinc-600";
            return (
              <tr
                key={`${r.labName}|||${r.labPanel ?? ""}`}
                className="border-t border-zinc-100"
              >
                <td className="px-3 py-2 text-zinc-900">{r.labName}</td>
                <td className="px-3 py-2 text-zinc-700">{r.labPanel ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {r.sampleCount}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {r.meanDays}d
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-900">
                  {r.p50Days}d
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {r.p90Days}d
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                  {catalog}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${driftClass}`}>
                  {r.drift == null
                    ? "—"
                    : r.drift > 0
                      ? `+${r.drift}d`
                      : `${r.drift}d`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
