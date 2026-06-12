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
/** Known IV providers (from the appointment history) for the form's provider
 *  picker. The session's Zenoti therapist is added on top of this if missing. */
export const IV_PROVIDERS = [
  "Alexander Moran",
  "Rich Rocha",
  "Rolando Mendoza",
  "Catherine Alas",
];

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

// ── Default chart (placeholder, persisted once at session creation) ──────────
// Mirrors worker/src/iv/default-chart.ts — keep the two in sync. Vitals are
// randomized within normal adult ranges (PLACEHOLDERS to be verified, not
// measured), so a new session shows editable values in the form and its posted
// note is never blank.
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const randDec = (lo: number, hi: number) => (lo + Math.random() * (hi - lo)).toFixed(1);

function ageFromDob(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Plausible, randomized (not measured) vitals for the patient's age. */
export function randomVitals(dob?: string | null): Vitals {
  const age = ageFromDob(dob);
  const elderly = age != null && age >= 65;
  const sys = elderly ? randInt(118, 138) : randInt(108, 128);
  const dia = elderly ? randInt(72, 84) : randInt(68, 80);
  return {
    bp: `${sys}/${dia}`,
    spo2: String(randInt(97, 100)),
    temp: randDec(97.7, 98.9),
    hr: String(randInt(62, 84)),
    resp: String(randInt(12, 18)),
  };
}

/** A complete default chart for a NEW session: the normal-visit boilerplate +
 *  placeholder vitals + gauge by service. EBOO/EBO2/Luma use a larger bore
 *  (mapped to the 20 column — only 20/22/PICC exist in PB today), else 22. */
export function defaultIvChart(opts: { kind?: string; serviceName?: string; dob?: string | null }): IvChart {
  const s = (opts.serviceName ?? "").toLowerCase();
  const cath = opts.kind === "ebo" || /\bluma\b/.test(s) ? "20" : "22";
  return {
    ...QUICK_FILL_NORMAL,
    ivStart: { cath },
    preVitals: randomVitals(opts.dob),
    postVitals: randomVitals(opts.dob),
  };
}
