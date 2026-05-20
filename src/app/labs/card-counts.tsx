"use client";

import type { CardCounts } from "./draw-actions";

export type { CardCounts };

export const ZERO_COUNTS: CardCounts = { openAttempts: 0, emailCount: 0 };

/**
 * Single shared palette for every card chip and tint. Traffic-light
 * semantics — green good / yellow caution / orange warn / red alert —
 * with one neutral slate for purely informational counts and blue for
 * "actionable but not bad" states (ready, in transit).
 *
 * Pulled into one place so all card surfaces (LabKanbanBoard,
 * PatientCard, PatientFocusBoard) decode the same way.
 */
export const CHIP = {
  info: "bg-slate-200 text-slate-700",
  good: "bg-green-100 text-green-700",
  caution: "bg-yellow-100 text-yellow-800",
  warn: "bg-orange-100 text-orange-800",
  alert: "bg-red-100 text-red-700",
  state: "bg-blue-100 text-blue-800",
  stateStrong: "bg-blue-200 text-blue-900",
  muted: "bg-slate-200 text-slate-500",
} as const;

/** Tracking-status pill classes + label, shared across all card surfaces. */
export const TRACKING_BADGE: Record<string, { label: string; className: string }> = {
  pre_transit: { label: "Pre-transit", className: CHIP.info },
  in_transit: { label: "In transit", className: CHIP.state },
  out_for_delivery: { label: "Out for delivery", className: CHIP.stateStrong },
  delivered: { label: "Delivered", className: CHIP.good },
  exception: { label: "Exception", className: CHIP.alert },
  returned: { label: "Returned", className: CHIP.alert },
  unknown: { label: "Unknown", className: CHIP.muted },
};

/**
 * Contact-attempt chip escalation:
 *   1 → caution (yellow), 2 → warn (orange), 3+ → alert (red).
 */
function attemptChipClasses(openAttempts: number): string {
  if (openAttempts === 1) return CHIP.caution;
  if (openAttempts === 2) return CHIP.warn;
  return CHIP.alert;
}

/**
 * Subtle card-level tint matching the chip palette. Faint background so
 * it doesn't fight foreground chips, but enough to pop in a column scan.
 */
export function attemptCardClasses(openAttempts: number): string {
  if (openAttempts <= 0) return "border-slate-200 bg-white";
  if (openAttempts === 1) return "border-yellow-200 bg-yellow-50/70";
  if (openAttempts === 2) return "border-orange-200 bg-orange-50/70";
  return "border-red-200 bg-red-50/70";
}

/**
 * Single uniformly-styled chip for the card's right rail. Each card
 * stacks these vertically in a fixed reading order so the eye finds the
 * same chip in the same position across every card.
 */
export function RailChip({
  className,
  title,
  children,
}: {
  className: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`block rounded px-1 py-0.5 text-center text-[9px] font-medium uppercase tabular-nums tracking-wide ${className}`}
    >
      {children}
    </span>
  );
}

/** Right-rail attempts chip. Color escalates with count. */
export function AttemptRailChip({ openAttempts }: { openAttempts: number }) {
  if (openAttempts <= 0) return null;
  return (
    <RailChip
      className={attemptChipClasses(openAttempts)}
      title={`${openAttempts} contact attempt${openAttempts === 1 ? "" : "s"} since last reached`}
    >
      📞 {openAttempts}
    </RailChip>
  );
}

/** Right-rail emails-sent chip. Neutral slate — pure count, no escalation. */
export function EmailRailChip({ emailCount }: { emailCount: number }) {
  if (emailCount <= 0) return null;
  return (
    <RailChip
      className={CHIP.info}
      title={`${emailCount} email${emailCount === 1 ? "" : "s"} sent on this case`}
    >
      ✉️ {emailCount}
    </RailChip>
  );
}

/**
 * Legacy inline chip row — kept for surfaces that haven't migrated to
 * the right-rail layout yet. New code should use AttemptRailChip and
 * EmailRailChip directly in a vertical stack.
 */
export function CountChips({ counts }: { counts: CardCounts }) {
  const { openAttempts, emailCount } = counts;
  if (openAttempts <= 0 && emailCount <= 0) return null;
  return (
    <>
      {openAttempts > 0 ? (
        <span
          title={`${openAttempts} contact attempt${openAttempts === 1 ? "" : "s"} since last reached`}
          className={`rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide tabular-nums ${attemptChipClasses(openAttempts)}`}
        >
          📞 {openAttempts}
        </span>
      ) : null}
      {emailCount > 0 ? (
        <span
          title={`${emailCount} email${emailCount === 1 ? "" : "s"} sent on this case`}
          className={`rounded px-1 py-0.5 text-[9px] font-medium tabular-nums ${CHIP.info}`}
        >
          ✉️ {emailCount}
        </span>
      ) : null}
    </>
  );
}
