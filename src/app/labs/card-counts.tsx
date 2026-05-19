"use client";

import type { CardCounts } from "./draw-actions";

export type { CardCounts };

export const ZERO_COUNTS: CardCounts = { openAttempts: 0, emailCount: 0 };

/**
 * Background + border classes applied to the whole card based on open
 * Nadia-style contact attempts. Escalates amber → orange → rose so the
 * operator sees at a glance who hasn't been reached yet.
 *
 * Returns null when there are no open attempts so the caller can fall
 * back to its default (likely-ready highlight, laggard tint, plain white).
 */
export function attemptTintClasses(openAttempts: number): string | null {
  if (openAttempts <= 0) return null;
  if (openAttempts === 1) return "border-amber-300 bg-amber-100";
  if (openAttempts === 2) return "border-orange-300 bg-orange-100";
  return "border-rose-400 bg-rose-100";
}

/**
 * The touch chips that sit alongside the existing badges row on each
 * card. Renders nothing when both counts are zero so quiet cards stay
 * quiet.
 */
export function CountChips({ counts }: { counts: CardCounts }) {
  const { openAttempts, emailCount } = counts;
  if (openAttempts <= 0 && emailCount <= 0) return null;
  return (
    <>
      {openAttempts > 0 ? (
        <span
          title={`${openAttempts} contact attempt${openAttempts === 1 ? "" : "s"} since last reached`}
          className="rounded bg-white/70 px-1 py-0.5 text-[9px] font-medium tabular-nums text-zinc-700"
        >
          📞 {openAttempts}
        </span>
      ) : null}
      {emailCount > 0 ? (
        <span
          title={`${emailCount} email${emailCount === 1 ? "" : "s"} sent on this case`}
          className="rounded bg-white/70 px-1 py-0.5 text-[9px] font-medium tabular-nums text-zinc-700"
        >
          ✉️ {emailCount}
        </span>
      ) : null}
    </>
  );
}
