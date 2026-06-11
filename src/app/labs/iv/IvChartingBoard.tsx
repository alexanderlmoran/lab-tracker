"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { IvSessionRow } from "./actions";

const KIND_STYLE: Record<string, { label: string; cls: string }> = {
  standard: { label: "Standard", cls: "bg-zinc-100 text-zinc-700 border-zinc-300" },
  ebo: { label: "EBOO/EBO2", cls: "bg-violet-100 text-violet-800 border-violet-300" },
  pc: { label: "PC infusion", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  custom: { label: "Custom", cls: "bg-sky-100 text-sky-800 border-sky-300" },
  addon: { label: "Add-on", cls: "bg-zinc-100 text-zinc-500 border-zinc-300" },
};

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending: { label: "Not charted", cls: "bg-zinc-100 text-zinc-600" },
  ready: { label: "Charted · awaiting Approve", cls: "bg-blue-100 text-blue-800" },
  posted: { label: "Posted to PB", cls: "bg-green-100 text-green-800" },
  skipped: { label: "Manual / skipped", cls: "bg-zinc-100 text-zinc-500" },
};

/** Shift a YYYY-MM-DD string by N days, staying in UTC so DST never skews it. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** start_at is an ISO string built from Zenoti's local clock — show HH:MM. */
function fmtTime(startAt: string | null): string {
  if (!startAt) return "—";
  const m = startAt.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "—";
}

function patientName(r: IvSessionRow): string {
  if (r.patient_full_name) return r.patient_full_name;
  const n = `${r.patient_first_name ?? ""} ${r.patient_last_name ?? ""}`.trim();
  return n || "—";
}

export function IvChartingBoard({
  rows,
  date,
  loadError,
}: {
  rows: IvSessionRow[];
  date: string;
  loadError: string | null;
}) {
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const t = (a.start_at ?? "").localeCompare(b.start_at ?? "");
        if (t !== 0) return t;
        // Base IVs before their add-ons at the same time.
        if (a.is_add_on !== b.is_add_on) return a.is_add_on ? 1 : -1;
        return patientName(a).localeCompare(patientName(b));
      }),
    [rows],
  );

  const tableMissing =
    !!loadError &&
    (loadError.includes("iv_sessions") ||
      loadError.toLowerCase().includes("does not exist") ||
      loadError.toLowerCase().includes("relation"));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-zinc-900">IV Charting</h1>
        <div className="ml-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-0.5 text-xs">
          <Link
            href={`/labs/iv?date=${shiftDate(date, -1)}`}
            className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100"
          >
            ← Prev
          </Link>
          <span className="px-2 py-1 font-medium text-zinc-900">{date}</span>
          <Link
            href={`/labs/iv?date=${shiftDate(date, 1)}`}
            className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100"
          >
            Next →
          </Link>
        </div>
        <span className="text-xs text-zinc-500">
          {sorted.length} IV appointment{sorted.length === 1 ? "" : "s"}
        </span>
      </div>

      {tableMissing ? (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
          The <code className="font-mono">iv_sessions</code> table isn&apos;t created yet. Apply{" "}
          <code className="font-mono">supabase/migrations/20260609_iv_sessions.sql</code>, then run the
          Zenoti IV sync to populate this day.
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-dashed border-red-300 bg-red-50 p-6 text-sm text-red-900">
          Couldn&apos;t load IV sessions: {loadError}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
          <p className="text-sm text-zinc-600">No IV appointments synced for {date}.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Run the Zenoti IV sync to populate this day.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-500">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Service</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">PB template</th>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sorted.map((r) => {
                const k = KIND_STYLE[r.kind] ?? KIND_STYLE.standard;
                const s = STATUS_STYLE[r.charting_status] ?? STATUS_STYLE.pending;
                const tmpl =
                  r.kind === "ebo"
                    ? "manual (hand-charted)"
                    : r.kind === "pc"
                      ? `Phosphatidylcholine Infusion${
                          r.pc_infusion_number ? ` (#${r.pc_infusion_number})` : ""
                        }`
                      : r.template_hint || "—";
                return (
                  <tr key={r.id} className={r.is_add_on ? "bg-zinc-50/60" : ""}>
                    <td className="px-3 py-2 tabular-nums text-zinc-900">{fmtTime(r.start_at)}</td>
                    <td className="px-3 py-2 font-medium text-zinc-900">{patientName(r)}</td>
                    <td
                      className={`px-3 py-2 ${
                        r.is_add_on ? "pl-6 text-zinc-600" : "text-zinc-900"
                      }`}
                    >
                      {r.is_add_on ? "↳ " : ""}
                      {r.service_name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${k.cls}`}
                      >
                        {k.label}
                      </span>
                      {r.weber ? (
                        <span className="ml-1 inline-flex rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-800">
                          Weber
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">{tmpl}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.therapist_name || "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${s.cls}`}
                      >
                        {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/labs/iv/${r.id}`}
                        className="rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                      >
                        Chart →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-zinc-400">
        Charting form + confidence-graded PB posting are live. The post worker grades the patient
        match (name + DOB + email) and auto-posts at ≥95; lower-confidence matches hold for review.
        EBOO/EBO2 are charted by hand in PB.
      </p>
    </div>
  );
}
