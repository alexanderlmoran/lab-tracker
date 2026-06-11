// Shared (client-safe) helpers for the IV charting form + board. Kept separate
// from actions.ts because a "use server" module can only export async actions.
import type { IvChart, Vitals } from "./actions";

const vitalsEmpty = (v?: Vitals) => !v || !(v.bp || v.spo2 || v.temp || v.hr || v.resp);

/**
 * Which key sections of a chart are still unfilled. Drives the "incomplete —
 * needs completion" flag. Posting is allowed regardless of this (a note must
 * never go missing); the flag just surfaces the follow-up to do.
 */
export function ivChartMissing(chart: IvChart | null | undefined): string[] {
  const c = chart ?? {};
  const missing: string[] = [];
  if (vitalsEmpty(c.preVitals)) missing.push("pre-vitals");
  if (vitalsEmpty(c.postVitals)) missing.push("post-vitals");
  if (!c.ivStart?.cath) missing.push("IV start");
  if (!(c.components ?? []).some((r) => (r.name ?? "").trim())) missing.push("components");
  return missing;
}

export function isIvChartIncomplete(chart: IvChart | null | undefined): boolean {
  return ivChartMissing(chart).length > 0;
}

/**
 * One-tap "normal visit" defaults for quick entry — the boilerplate that's the
 * same almost every time. Leaves the real per-visit data (vitals, components,
 * PC #/vials) for the nurse to enter.
 */
export const QUICK_FILL_NORMAL: Partial<IvChart> = {
  assessment: {
    initialCheckIn: true,
    risksDiscussed: true,
    consentSigned: true,
    intakeSigned: true,
    historyDiscussed: true,
  },
  ivStart: { cath: "22" },
  attempts: "1",
  location: "right_antecubital",
  infusionFlowingWell: true,
  infusionReaction: { occurred: false },
  ivRemoval: true,
};
