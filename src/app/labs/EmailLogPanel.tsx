"use client";

import { useEffect, useState } from "react";
import type { EmailLog } from "@/lib/types";
import { listEmailLogs } from "./email-actions";

/**
 * Inline "what emails went out for this case" panel for CaseDetail.
 * Replaces the implicit "check the activity log and scroll" workflow when
 * you just need to confirm "did Email 3 send?". Shows the latest entry per
 * kind plus a count when there have been multiple sends (resent or
 * skipped + sent), with the most recent timestamp.
 */
const KIND_LABEL: Record<string, string> = {
  // Patient-facing — these match the EmailKind values stored in email_logs.
  sample_sent: "Email 1 — Sample sent to patient",
  partial_uploaded: "Email 2 — Partial results uploaded",
  complete_uploaded: "Email 3 — Complete results uploaded",
  rof_followup: "Email 4 — ROF follow-up",
  // Staff-facing — fired automatically by workflow.ts when all of a
  // patient's active labs reach a certain step. Shown here so staff can
  // confirm Nadia / Allison got pinged without opening the activity log.
  nadia_all_received: "Nadia — all labs received (confirm)",
  rof_allison: "Allison — ROF review",
  // Digest / batch — included for completeness; not normally per-case.
  stale_digest: "Stale-case digest",
  rof_reminder: "ROF reminder",
};

type Row = {
  kind: string;
  status: EmailLog["status"];
  createdAt: string;
  errorMessage: string | null;
  count: number;
};

function rollup(logs: EmailLog[]): Row[] {
  const byKind = new Map<string, Row>();
  for (const log of logs) {
    const prev = byKind.get(log.kind);
    if (!prev) {
      byKind.set(log.kind, {
        kind: log.kind,
        status: log.status,
        createdAt: log.created_at,
        errorMessage: log.error_message,
        count: 1,
      });
      continue;
    }
    prev.count += 1;
    if (log.created_at > prev.createdAt) {
      prev.createdAt = log.created_at;
      prev.status = log.status;
      prev.errorMessage = log.error_message;
    }
  }
  return [...byKind.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
}

function statusChip(status: EmailLog["status"]) {
  const map: Record<EmailLog["status"], { label: string; className: string }> = {
    sent: { label: "sent", className: "bg-emerald-100 text-emerald-800" },
    skipped: { label: "skipped", className: "bg-zinc-200 text-zinc-700" },
    failed: { label: "failed", className: "bg-rose-100 text-rose-800" },
    queued: { label: "queued", className: "bg-amber-100 text-amber-800" },
  };
  const s = map[status] ?? { label: status, className: "bg-zinc-200 text-zinc-700" };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.className}`}
    >
      {s.label}
    </span>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EmailLogPanel({ caseId }: { caseId: string }) {
  const [logs, setLogs] = useState<EmailLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listEmailLogs(caseId)
      .then((data) => {
        if (!cancelled) setLogs(data);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (error) {
    return (
      <p className="text-xs text-rose-700">Couldn&apos;t load emails: {error}</p>
    );
  }
  if (logs === null) {
    return <p className="text-xs text-zinc-400">Loading…</p>;
  }
  if (logs.length === 0) {
    return (
      <p className="text-xs text-zinc-500">No emails sent for this case yet.</p>
    );
  }
  const rows = rollup(logs);
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li
          key={r.kind}
          className="flex flex-wrap items-center gap-2 text-xs"
          title={r.errorMessage ?? undefined}
        >
          <span className="min-w-0 flex-1 truncate text-zinc-700">
            {KIND_LABEL[r.kind] ?? r.kind}
          </span>
          {statusChip(r.status)}
          <span className="text-[11px] tabular-nums text-zinc-500">
            {formatTimestamp(r.createdAt)}
          </span>
          {r.count > 1 ? (
            <span className="text-[10px] text-zinc-400">×{r.count}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
