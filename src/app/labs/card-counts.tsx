"use client";

import type { CardCounts } from "./draw-actions";

export type { CardCounts };

export const ZERO_COUNTS: CardCounts = { openAttempts: 0, emailCount: 0 };

/**
 * Color classes for the contact-attempt chip — same palette as the
 * tracking-status badges so escalation reads visually:
 *   1 attempt  → amber
 *   2 attempts → orange
 *   3+         → rose
 */
function attemptChipClasses(openAttempts: number): string {
  if (openAttempts === 1) return "bg-amber-100 text-amber-800";
  if (openAttempts === 2) return "bg-orange-100 text-orange-800";
  return "bg-rose-100 text-rose-800";
}

/**
 * The touch chips that sit alongside the existing badges row on each
 * card. Renders nothing when both counts are zero so quiet cards stay
 * quiet. The contact-attempt chip uses the same shape and palette as the
 * tracking-status chips (Delivered, In transit, etc) — escalates from
 * amber → orange → rose so the operator catches it at a glance without a
 * full-card color change.
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
          className="rounded bg-zinc-100 px-1 py-0.5 text-[9px] font-medium tabular-nums text-zinc-600"
        >
          ✉️ {emailCount}
        </span>
      ) : null}
    </>
  );
}
