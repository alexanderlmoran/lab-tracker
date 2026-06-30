"use client";

import { useMemo, useState } from "react";
import { toolbarBtn } from "../toolbar-styles";
import type { PhlebApptRow } from "./actions";
import { PhlebApptDrawer } from "./PhlebApptDrawer";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Eastern (clinic) YYYY-MM-DD for an ISO instant. */
function easternDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function easternTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
}
function ymdKey(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Month calendar of mobile-phlebotomy draws. Each draw lands on its confirmed
 * appointment time (appt_at) when scheduled, otherwise its collection_date;
 * draws with neither are listed below. Clicking a draw opens the same
 * appointment drawer as the board. `todayKey` is the clinic-Eastern date passed
 * from the server so SSR and the client agree (no `new Date()` "now").
 */
export function PhlebCalendar({ rows, todayKey }: { rows: PhlebApptRow[]; todayKey: string }) {
  const [ty, tm] = useMemo(() => {
    const [y, m] = todayKey.split("-").map(Number);
    return [y, (m ?? 1) - 1];
  }, [todayKey]);

  const [view, setView] = useState({ y: ty, m: tm }); // m is 0-based
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRow = selectedId ? rows.find((r) => r.case_id === selectedId) ?? null : null;

  const { byDate, undated } = useMemo(() => {
    const map = new Map<string, PhlebApptRow[]>();
    const none: PhlebApptRow[] = [];
    for (const r of rows) {
      const key = r.appt_at ? easternDateKey(r.appt_at) : r.collection_date ?? null;
      if (!key) {
        none.push(r);
        continue;
      }
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    // Soonest appointment first within a day.
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.appt_at ?? "").localeCompare(b.appt_at ?? ""));
    }
    return { byDate: map, undated: none };
  }, [rows]);

  const cells = useMemo(() => {
    const firstDow = new Date(view.y, view.m, 1).getDay();
    const out: { key: string; day: number; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(view.y, view.m, 1 - firstDow + i);
      out.push({
        key: ymdKey(d.getFullYear(), d.getMonth(), d.getDate()),
        day: d.getDate(),
        inMonth: d.getMonth() === view.m,
      });
    }
    return out;
  }, [view]);

  function shift(delta: number) {
    setView((v) => {
      const total = v.y * 12 + v.m + delta;
      return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className={toolbarBtn(false)} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <span className="min-w-[140px] text-center text-sm font-semibold text-zinc-900">
          {MONTHS[view.m]} {view.y}
        </span>
        <button type="button" className={toolbarBtn(false)} onClick={() => shift(1)} aria-label="Next month">›</button>
        <button type="button" className={toolbarBtn(false)} onClick={() => setView({ y: ty, m: tm })}>Today</button>
        <span className="text-xs text-zinc-500">
          {rows.length} draw{rows.length === 1 ? "" : "s"} · on appointment time, else collection date
        </span>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="mt-1 grid flex-1 grid-cols-7 grid-rows-6 gap-1 lg:min-h-0">
        {cells.map((cell) => {
          const draws = byDate.get(cell.key) ?? [];
          const isToday = cell.key === todayKey;
          return (
            <div
              key={cell.key}
              className={`flex min-h-0 flex-col rounded-lg border p-1 ${
                cell.inMonth ? "border-zinc-200 bg-white" : "border-zinc-100 bg-zinc-50/40"
              } ${isToday ? "ring-1 ring-indigo-400" : ""}`}
            >
              <div
                className={`text-[10px] ${
                  isToday ? "font-bold text-indigo-600" : cell.inMonth ? "text-zinc-500" : "text-zinc-300"
                }`}
              >
                {cell.day}
              </div>
              <div className="mt-0.5 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
                {draws.map((d) => (
                  <button
                    key={d.case_id}
                    type="button"
                    onClick={() => setSelectedId(d.case_id)}
                    title={`${d.patient_name}${d.appt_at ? ` · ${easternTime(d.appt_at)}` : " · collection date (not scheduled)"}`}
                    className={`truncate rounded px-1 py-0.5 text-left text-[10px] ${
                      d.appt_at
                        ? "bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                    }`}
                  >
                    {d.appt_at ? `${easternTime(d.appt_at)} · ` : ""}
                    {d.patient_name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {undated.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <span>{undated.length} draw{undated.length === 1 ? "" : "s"} with no date yet:</span>
          {undated.map((d) => (
            <button
              key={d.case_id}
              type="button"
              onClick={() => setSelectedId(d.case_id)}
              className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-200"
            >
              {d.patient_name}
            </button>
          ))}
        </div>
      ) : null}

      <PhlebApptDrawer row={selectedRow} onClose={() => setSelectedId(null)} />
    </div>
  );
}
