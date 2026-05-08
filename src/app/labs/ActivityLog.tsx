"use client";

import { useEffect, useState } from "react";
import type { LabEvent } from "@/lib/types";
import { listLabEvents } from "./actions";

function fmtTs(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function describe(ev: LabEvent): string {
  switch (ev.kind) {
    case "case_created":
      return "Case created";
    case "case_edited": {
      const changes = (ev.meta as { changes?: Record<string, unknown> } | null)
        ?.changes;
      const fields = changes ? Object.keys(changes) : [];
      return fields.length
        ? `Edited: ${fields.join(", ")}`
        : "Case edited";
    }
    case "case_archived":
      return "Case archived";
    case "case_unarchived":
      return "Case unarchived";
    case "step_toggled":
      return `Step ${ev.step ?? "?"} ${ev.completed ? "completed" : "uncompleted"}`;
    case "email_sent":
      return "Email sent";
    case "email_failed":
      return "Email failed";
    case "email_skipped":
      return "Email skipped";
    default:
      return ev.kind;
  }
}

export function ActivityLog({ caseId }: { caseId: string }) {
  const [events, setEvents] = useState<LabEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ul className="divide-y divide-zinc-100 text-xs">
      {events.map((ev) => (
        <li key={ev.id} className="flex items-start gap-3 py-2">
          <span className="w-32 shrink-0 font-mono text-zinc-500">
            {fmtTs(ev.created_at)}
          </span>
          <span className="w-32 shrink-0 truncate text-zinc-600">
            {ev.actor}
          </span>
          <span className="text-zinc-900">
            {describe(ev)}
            {ev.note ? (
              <span className="ml-1 text-zinc-500">— {ev.note}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
