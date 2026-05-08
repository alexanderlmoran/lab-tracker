import type { LabCase } from "@/lib/types";
import { STEP_BOOLEAN_COLUMNS } from "@/lib/types";
import { CaseRowActions } from "./CaseRowActions";

function progressOf(c: LabCase) {
  return STEP_BOOLEAN_COLUMNS.reduce(
    (n, key) => (c[key] ? n + 1 : n),
    0,
  );
}

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function CaseTable({ rows }: { rows: LabCase[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-10 text-center">
        <p className="text-sm text-zinc-600">No cases yet.</p>
        <p className="mt-1 text-xs text-zinc-500">
          Create one to start tracking through the 9-step lifecycle.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Patient</th>
            <th className="px-4 py-2 text-left font-medium">Lab</th>
            <th className="px-4 py-2 text-left font-medium">Tracking</th>
            <th className="px-4 py-2 text-left font-medium">Progress</th>
            <th className="px-4 py-2 text-left font-medium">Updated</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row) => {
            const done = progressOf(row);
            return (
              <tr key={row.id} className="hover:bg-zinc-50/60">
                <td className="px-4 py-3 align-top">
                  <div className="font-medium text-zinc-900">
                    {row.patient_name}
                  </div>
                  <div className="text-xs text-zinc-500">{row.patient_email}</div>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="text-zinc-900">{row.lab_name}</div>
                  {row.lab_panel ? (
                    <div className="text-xs text-zinc-500">{row.lab_panel}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 align-top text-xs text-zinc-700">
                  {row.tracking_number ?? "—"}
                </td>
                <td className="px-4 py-3 align-top">
                  <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                    {done} / 9
                  </span>
                </td>
                <td className="px-4 py-3 align-top text-xs text-zinc-500">
                  {timeAgo(row.updated_at)}
                </td>
                <td className="px-4 py-3 align-top">
                  <CaseRowActions row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
