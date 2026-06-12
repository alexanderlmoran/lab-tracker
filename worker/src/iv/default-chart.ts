// Default IV chart: plausible, age-appropriate placeholder values so a posted
// note is never blank. These are DEFAULTS — any value the staff actually charted
// wins (see mergeIvChart). Generated vitals are placeholders to be verified, in
// line with the "auto-fill then manually edit" workflow; they are randomized
// within normal adult ranges, not measured.
//
// Gauge note: the PB "IV Start" grid only has 20 / 22 / PICC columns today, so
// EBOO/EBO2/Luma map to 20 and everything else to 22. Adding 24 / 18 / Midline
// needs those columns added to the PB templates first.

import type { IvChartInput } from "./build-note-content.js";

/** Whole years from a YYYY-MM-DD DOB at today's date, or null if unparseable. */
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

/** Random integer in [lo, hi]. */
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
/** Random 1-decimal number in [lo, hi]. */
const randDec = (lo: number, hi: number) => (lo + Math.random() * (hi - lo)).toFixed(1);

/** A plausible vitals set for the given age. Ranges widen slightly for 65+;
 *  adult ranges otherwise. Format mirrors the charting form's string fields. */
function randomVitals(age: number | null): NonNullable<IvChartInput["preVitals"]> {
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

/** EBOO/EBO2/Luma Elite use a larger-bore catheter (mapped to the 20 column);
 *  everything else defaults to 22. */
function defaultGauge(kind?: string, serviceName?: string): string {
  const s = (serviceName ?? "").toLowerCase();
  if (kind === "ebo" || /\bluma\b/.test(s)) return "20";
  return "22";
}

/** Build a complete default chart. Vitals are freshly randomized each call. */
export function defaultIvChart(opts: { kind?: string; serviceName?: string; dob?: string | null }): IvChartInput {
  const age = ageFromDob(opts.dob);
  return {
    assessment: {
      initialCheckIn: true,
      risksDiscussed: true,
      consentSigned: true,
      intakeSigned: true,
      historyDiscussed: true,
    },
    preVitals: randomVitals(age),
    postVitals: randomVitals(age),
    ivStart: { cath: defaultGauge(opts.kind, opts.serviceName) },
    attempts: "1",
    location: "right_antecubital",
    infusionFlowingWell: true,
    infusionReaction: { occurred: false },
    ivRemoval: true,
  };
}

/** Overlay the saved chart on top of defaults — any field the staff actually
 *  charted wins; defaults only fill what's unset. Nested objects (assessment,
 *  vitals, ivStart) merge per-key so a partial chart keeps its defaults. */
export function mergeIvChart(defaults: IvChartInput, saved: IvChartInput | undefined): IvChartInput {
  const s = saved ?? {};
  return {
    ...defaults,
    ...s,
    assessment: { ...defaults.assessment, ...s.assessment },
    preVitals: { ...defaults.preVitals, ...s.preVitals },
    postVitals: { ...defaults.postVitals, ...s.postVitals },
    ivStart: { ...defaults.ivStart, ...s.ivStart },
    infusionReaction: { ...defaults.infusionReaction, ...s.infusionReaction },
  };
}
