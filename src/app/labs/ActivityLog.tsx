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
    case "contact_attempted":
      return "Contact attempted";
    case "contact_reached":
      return "Patient reached";
    case "audit_approve":
      return "PDF approved → PB upload queued";
    case "audit_disapprove_wrong_pdf":
      return "PDF rejected (wrong patient / corrupt) — scraper will re-match";
    case "audit_disapprove_upload_failed":
      return "PB upload failed";
    case "audit_retry_upload":
      return "Retry requested — PB upload re-queued";
    case "audit_manual_override":
      return "Manual override";
    case "audit_accession_edited":
      return "Accession # edited";
    default:
      return ev.kind;
  }
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

  const showCompact = compact && !expanded;
  const visible = showCompact ? events.slice(0, 5) : events;
  const hidden = events.length - visible.length;

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
              {describe(ev)}
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
    </div>
  );
}
