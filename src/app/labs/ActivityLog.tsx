"use client";

import { useEffect, useMemo, useState } from "react";
import type { LabEvent } from "@/lib/types";
import { humanizeEvent, isMajorEvent } from "@/lib/labs/humanize-event";
import { listLabEvents } from "./actions";

function fmtTs(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function ActivityLog({
  caseId,
  compact = false,
}: {
  caseId: string;
  /** When true, collapse to the most recent 5 with a "Show all" expander. */
  compact?: boolean;
}) {
  const [events, setEvents] = useState<LabEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Signal/noise: the log defaults to MAJOR events only so routine polls and
  // skips don't bury the steps/edits staff care about. The minor events are
  // one click away, not gone.
  const [showMinor, setShowMinor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listLabEvents(caseId)
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load activity");
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const major = useMemo(
    () => (events ?? []).filter(isMajorEvent),
    [events],
  );

  if (error) {
    return (
      <p className="text-xs text-red-600" role="alert">
        {error}
      </p>
    );
  }
  if (!events) {
    return <p className="text-xs text-zinc-500">Loading activity…</p>;
  }
  if (events.length === 0) {
    return <p className="text-xs text-zinc-500">No activity yet.</p>;
  }

  const minorCount = events.length - major.length;
  // Apply the signal/noise filter first, then the compact top-5 collapse.
  const filtered = showMinor ? events : major;
  const showCompact = compact && !expanded;
  const visible = showCompact ? filtered.slice(0, 5) : filtered;
  const hidden = filtered.length - visible.length;

  return (
    <div className="flex min-h-0 flex-col">
      <ul
        className={`divide-y divide-zinc-100 text-xs ${
          compact && expanded ? "max-h-64 overflow-y-auto" : ""
        }`}
      >
        {visible.map((ev) => (
          <li key={ev.id} className="flex items-start gap-2 py-1.5">
            <span className="w-28 shrink-0 font-mono text-[11px] text-zinc-500">
              {fmtTs(ev.created_at)}
            </span>
            <span className="min-w-0 flex-1 text-zinc-900">
              {humanizeEvent(ev).text}
              {ev.note ? (
                <span className="ml-1 text-zinc-500">— {ev.note}</span>
              ) : null}
              <span className="ml-1 text-[10px] text-zinc-400">
                {ev.actor}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {filtered.length === 0 ? (
        <p className="py-1.5 text-xs text-zinc-500">No major activity yet.</p>
      ) : null}
      {compact && hidden > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 self-start text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          Show all ({events.length})
        </button>
      ) : null}
      {compact && expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 self-start text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          Show fewer
        </button>
      ) : null}
      {minorCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowMinor((v) => !v)}
          className="mt-1 self-start text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          {showMinor
            ? "Hide minor activity"
            : `Show minor activity (${minorCount})`}
        </button>
      ) : null}
    </div>
  );
}
