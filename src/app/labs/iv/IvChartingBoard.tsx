"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { enqueueIvPost, markIvAlreadyDone, type IvChart, type IvSessionRow } from "./actions";
import { isIvChartIncomplete } from "./chart-util";

const PB_URL = "https://my.practicebetter.io";

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
  posted: { label: "✓ Posted to PB", cls: "bg-green-100 text-green-800" },
  skipped: { label: "Manual / skipped", cls: "bg-zinc-100 text-zinc-500" },
};

/** Status badge for a row. EBOO/EBO2 are charted BY HAND in PB (the tracker can't
 *  post them), so a still-`pending` EBOO is NOT "Not charted" — it's waiting for
 *  its manual PB chart. And once staff mark it done, "Manual / skipped" reads as
 *  "didn't happen" when it actually IS charted — so show it as done. This keeps
 *  EBOO from looking forgotten on the board (the "shows Not charted but it's in
 *  PB" confusion). */
function statusBadge(r: IvSessionRow): { label: string; cls: string } {
  if (r.kind === "ebo") {
    // EBOO/EBO2 are hand-charted in PB. Once captured (auto-detected by the
    // reconcile pass → 'posted', or staff-dismissed → 'skipped') show it as
    // charted; otherwise it's awaiting its manual PB chart — NOT "Not charted".
    return r.charting_status === "posted" || r.charting_status === "skipped"
      ? { label: "✓ Charted in PB", cls: "bg-green-100 text-green-800" }
      : { label: "Awaiting PB chart", cls: "bg-violet-100 text-violet-800" };
  }
  return STATUS_STYLE[r.charting_status] ?? STATUS_STYLE.pending;
}

/** Deep-link into PracticeBetter: the exact posted note when we have both ids,
 *  else the patient's notes list, else PB's home (search by hand). */
function pbHref(r: IvSessionRow): string {
  const crid = r.pb_client_record_id;
  if (crid && r.pb_note_id) return `${PB_URL}/#/p/clients/${crid}/notes/${r.pb_note_id}/edit`;
  if (crid) return `${PB_URL}/#/p/clients/${crid}/notes/list?view=notes&sort=date_desc`;
  return PB_URL;
}

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
  const sorted = useMemo(() => {
    // Group all of a patient's appointments together (Alex: "names together"),
    // but anchor each patient's block at their EARLIEST slot so the daily board
    // still reads roughly top-to-bottom by time instead of alphabetically.
    const firstByPatient = new Map<string, string>();
    for (const r of rows) {
      const k = patientName(r);
      const t = r.start_at ?? "";
      const cur = firstByPatient.get(k);
      if (cur === undefined || t.localeCompare(cur) < 0) firstByPatient.set(k, t);
    }
    return [...rows].sort((a, b) => {
      const na = patientName(a);
      const nb = patientName(b);
      // 1) order patient blocks by each patient's first appointment of the day
      const fg = (firstByPatient.get(na) ?? "").localeCompare(firstByPatient.get(nb) ?? "");
      if (fg !== 0) return fg;
      // 2) tie on first-slot → keep the same patient's rows adjacent
      if (na !== nb) return na.localeCompare(nb);
      // 3) within a patient, chronological (e.g. 11:00 then 12:55 back-to-back)
      const t = (a.start_at ?? "").localeCompare(b.start_at ?? "");
      if (t !== 0) return t;
      // 4) at the same time, base IV before its add-on (↳ sits under its parent)
      if (a.is_add_on !== b.is_add_on) return a.is_add_on ? 1 : -1;
      return (a.service_name ?? "").localeCompare(b.service_name ?? "");
    });
  }, [rows]);

  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const markDone = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      try {
        await markIvAlreadyDone(id);
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  };
  // Enqueue for PB posting now (don't wait for the hourly/5pm sweep). The worker
  // grades the match and auto-posts (≥95) or holds for review within ~5 min.
  const approve = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      try {
        await enqueueIvPost(id);
        setQueued((q) => new Set(q).add(id));
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  };

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
                const s = statusBadge(r);
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
                    <td className="px-3 py-2 text-zinc-700">
                      {(r.chart as IvChart)?.provider || r.therapist_name || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${s.cls}`}
                      >
                        {s.label}
                      </span>
                      {(r.charting_status === "posted" || r.charting_status === "ready") &&
                        isIvChartIncomplete(r.chart as IvChart) && (
                          <span
                            className="ml-1 inline-flex rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                            title="Posted/charted but charting is incomplete — needs completion"
                          >
                            ⚠ incomplete
                          </span>
                        )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <a
                          href={pbHref(r)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                          title={
                            r.pb_client_record_id
                              ? r.pb_note_id
                                ? "Open this posted IV note in PracticeBetter"
                                : "Open this patient's notes in PracticeBetter"
                              : "Open PracticeBetter to search the chart / account notes"
                          }
                        >
                          PB →
                        </a>
                        {r.charting_status !== "posted" && r.charting_status !== "skipped" && (
                          <button
                            type="button"
                            disabled={pending && busyId === r.id}
                            onClick={() => markDone(r.id)}
                            className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                              r.kind === "ebo"
                                ? "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                                : "border border-zinc-300 text-zinc-700 hover:bg-zinc-100"
                            }`}
                            title={
                              r.kind === "ebo"
                                ? "EBOO/EBO2 is charted by hand in PB — click once you've charted it there to mark it done"
                                : "Already charted by hand in PB — dismiss from the board"
                            }
                          >
                            {pending && busyId === r.id ? "…" : r.kind === "ebo" ? "✓ Charted in PB" : "Already done"}
                          </button>
                        )}
                        {r.charting_status !== "posted" &&
                          r.charting_status !== "skipped" &&
                          r.kind !== "ebo" &&
                          !r.is_add_on &&
                          (queued.has(r.id) ? (
                            <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                              Queued · posting…
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={pending && busyId === r.id}
                              onClick={() => approve(r.id)}
                              className="rounded border border-zinc-900 bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                              title="Post to PB now — the worker grades the patient match and auto-posts (≥95) or holds for review within ~5 min (don't wait for the sweep)"
                            >
                              {pending && busyId === r.id ? "…" : "Approve & post"}
                            </button>
                          ))}
                        <Link
                          href={`/labs/iv/${r.id}`}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                        >
                          Chart →
                        </Link>
                      </div>
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
        EBOO/EBO2 are charted by hand in PB — they show <strong>Awaiting PB chart</strong> (not
        &ldquo;Not charted&rdquo;); click <strong>✓ Charted in PB</strong> once you&rsquo;ve charted it there.
      </p>
    </div>
  );
}
