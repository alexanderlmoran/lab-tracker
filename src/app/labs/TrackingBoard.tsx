"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { LabCase, TrackingStatus } from "@/lib/types";
import { formatPersonName } from "@/lib/format";

// Columns track the carrier-side lifecycle, not our workflow steps. "Needs
// attention" is a synthetic bucket that captures stuck shipments — anything
// pre_transit > 3 days with no event, or in_transit/out_for_delivery with
// no event in the last 3 days. Exception / Returned always land in
// "Needs attention" regardless of timing.

const STUCK_DAYS = 3;
const MS_PER_DAY = 86_400_000;

type TrackingColumnKey =
  | "attention"
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "no_tracking";

const COLUMN_ORDER: TrackingColumnKey[] = [
  "attention",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "no_tracking",
];

const COLUMN_LABEL: Record<TrackingColumnKey, string> = {
  attention: "Needs attention",
  pre_transit: "Pre-transit",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  no_tracking: "No tracking #",
};

const COLUMN_COLOR_VAR: Record<TrackingColumnKey, string> = {
  attention: "var(--c-stale)",
  pre_transit: "var(--c-new)",
  in_transit: "var(--c-sent)",
  out_for_delivery: "var(--c-rof-s)",
  delivered: "var(--c-rof-d)",
  no_tracking: "var(--c-new)",
};

type StuckReason = "exception" | "returned" | "stale_event" | "never_scanned" | null;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / MS_PER_DAY);
}

function stuckReason(c: LabCase): StuckReason {
  if (!c.tracking_number) return null;
  if (c.tracking_status === "exception") return "exception";
  if (c.tracking_status === "returned") return "returned";
  if (c.tracking_status === "delivered") return null;

  // Never scanned: in pre_transit > 3 days with no carrier event yet.
  if (c.tracking_status === "pre_transit" || c.tracking_status === null) {
    const sinceCreate = daysSince(c.created_at);
    const sinceEvent = daysSince(c.tracking_event_at);
    if (sinceEvent !== null && sinceEvent >= STUCK_DAYS) return "stale_event";
    if (sinceEvent === null && sinceCreate !== null && sinceCreate >= STUCK_DAYS) {
      return "never_scanned";
    }
    return null;
  }

  // Active states — no event in last 3 days = stale.
  const sinceEvent = daysSince(c.tracking_event_at);
  if (sinceEvent !== null && sinceEvent >= STUCK_DAYS) return "stale_event";
  return null;
}

function columnFor(c: LabCase): TrackingColumnKey {
  if (!c.tracking_number) return "no_tracking";
  if (stuckReason(c)) return "attention";
  const s: TrackingStatus | null = c.tracking_status ?? null;
  if (s === "delivered") return "delivered";
  if (s === "out_for_delivery") return "out_for_delivery";
  if (s === "in_transit") return "in_transit";
  return "pre_transit";
}

function carrierLabel(c: LabCase): string {
  if (c.tracking_carrier) return c.tracking_carrier.toUpperCase();
  // Light heuristic so cards aren't blank when carrier wasn't detected: FedEx
  // tracking numbers are usually 12 digits; UPS starts with 1Z; USPS is varied.
  const t = (c.tracking_number ?? "").trim();
  if (/^1Z/i.test(t)) return "UPS";
  if (/^\d{12}$/.test(t)) return "FedEx";
  if (/^9\d{19,21}$/.test(t)) return "USPS";
  return "—";
}

function statusLabel(c: LabCase): string {
  if (!c.tracking_status) return "—";
  return c.tracking_status.replace(/_/g, " ");
}

function timeAgo(iso: string | null): string | null {
  const d = daysSince(iso);
  if (d == null) return null;
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

export function TrackingBoard({ rows }: { rows: LabCase[] }) {
  const grouped = useMemo(() => {
    const map: Record<TrackingColumnKey, LabCase[]> = {
      attention: [],
      pre_transit: [],
      in_transit: [],
      out_for_delivery: [],
      delivered: [],
      no_tracking: [],
    };
    for (const c of rows) map[columnFor(c)].push(c);
    // Order within columns: stuck-longest first in attention, most recent
    // event first elsewhere, least-recently-updated first for no_tracking.
    map.attention.sort((a, b) => {
      const ax = a.tracking_event_at ?? a.created_at;
      const bx = b.tracking_event_at ?? b.created_at;
      return ax.localeCompare(bx); // oldest first
    });
    for (const k of ["pre_transit", "in_transit", "out_for_delivery", "delivered"] as const) {
      map[k].sort((a, b) => {
        const ax = a.tracking_event_at ?? a.created_at;
        const bx = b.tracking_event_at ?? b.created_at;
        return bx.localeCompare(ax); // most recent first
      });
    }
    return map;
  }, [rows]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {COLUMN_ORDER.map((col) => {
        const cases = grouped[col];
        return (
          <section
            key={col}
            className="kanban-col flex flex-col p-2 lg:min-h-0"
            data-col="untouched"
            style={{ ["--col-c" as string]: COLUMN_COLOR_VAR[col] }}
          >
            <header className="flex items-center justify-between px-2 py-1.5">
              <h3 className="col-head-title">{COLUMN_LABEL[col]}</h3>
              <span className="col-head-count">{cases.length}</span>
            </header>
            <div className="flex min-h-[40px] flex-col gap-2 p-1 lg:flex-1 lg:overflow-y-auto">
              {cases.map((c) => (
                <TrackingCard key={c.id} c={c} />
              ))}
              {cases.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TrackingCard({ c }: { c: LabCase }) {
  const reason = stuckReason(c);
  const eventAgo = timeAgo(c.tracking_event_at);
  const polledAgo = timeAgo(c.tracking_polled_at);
  const labLabel = c.lab_panel ? `${c.lab_name} · ${c.lab_panel}` : c.lab_name;

  return (
    <Link
      href={`/labs/${c.id}`}
      className="block rounded-md border border-zinc-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-zinc-900">
            {formatPersonName(c.patient_name)}
          </p>
          <p className="truncate text-[11px] text-zinc-500">{labLabel}</p>
        </div>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-700">
          {carrierLabel(c)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-600">
        <span className="capitalize">
          <strong className="font-medium text-zinc-900">{statusLabel(c)}</strong>
        </span>
        {c.tracking_location ? (
          <span className="text-zinc-500">· {c.tracking_location}</span>
        ) : null}
      </div>

      {c.tracking_number ? (
        <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
          {c.tracking_number}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[10px] text-zinc-400">
        <span>
          {eventAgo ? `Event ${eventAgo}` : "No carrier events yet"}
        </span>
        {polledAgo ? <span>Polled {polledAgo}</span> : null}
      </div>

      {reason ? <StuckBadge reason={reason} /> : null}
    </Link>
  );
}

function StuckBadge({ reason }: { reason: NonNullable<StuckReason> }) {
  const LABEL: Record<NonNullable<StuckReason>, string> = {
    exception: "Exception",
    returned: "Returned",
    stale_event: `No update in ${STUCK_DAYS}+ days`,
    never_scanned: `Never scanned (${STUCK_DAYS}+ days)`,
  };
  return (
    <div className="mt-2 flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-rose-500"
        style={{ boxShadow: "0 0 0 3px rgba(244, 63, 94, 0.22)" }}
      />
      {LABEL[reason]}
    </div>
  );
}
