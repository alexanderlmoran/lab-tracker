// Default IV chart: structural defaults so a posted note has the right shape.
// These are DEFAULTS — any value the staff actually charted wins (see
// mergeIvChart).
//
// VITALS ARE NEVER FABRICATED (Alex 2026-06-22). The old behavior generated
// randomized "plausible" BP/HR/SpO2/temp/resp so a note was never blank — but a
// posted note must show MEASURED vitals or nothing. An invented-but-plausible
// vital on a patient's chart is a clinical-integrity hazard (it raced/overwrote
// real values and read as real). Vitals now default to blank; a note that posts
// without them reads honestly as "not charted" and is flagged incomplete.
//
// Gauge note: the PB "IV Start" grid carries 20 / 22 / 24 columns (no PICC / 18 /
// Midline). EBOO/EBO2/Luma default to 20, everything else to 24. PICC / 18 /
// Midline (selectable in the form) have no grid column → recorded in the note
// summary instead (see ivNoteSummary in build-note-content.ts).

import type { IvChartInput } from "./build-note-content.js";

/** Empty vitals — never fabricated; only the operator's measured values appear
 *  (via mergeIvChart). Fresh object each call so callers can't share/mutate. */
const blankVitals = (): NonNullable<IvChartInput["preVitals"]> => ({
  bp: "",
  spo2: "",
  temp: "",
  hr: "",
  resp: "",
});

/** EBOO/EBO2/Luma Elite use a larger-bore catheter (20); everything else
 *  defaults to 24 (the common case). */
function defaultGauge(kind?: string, serviceName?: string): string {
  const s = (serviceName ?? "").toLowerCase();
  if (kind === "ebo" || /\bluma\b/.test(s)) return "20";
  return "24";
}

/** Build a default chart. Structural fields only; vitals stay blank unless the
 *  operator charted them. `dob` is accepted for signature stability (callers
 *  still pass it) but is no longer used now that vitals aren't age-derived. */
export function defaultIvChart(opts: { kind?: string; serviceName?: string; dob?: string | null }): IvChartInput {
  return {
    assessment: {
      initialCheckIn: true,
      risksDiscussed: true,
      consentSigned: true,
      intakeSigned: true,
      historyDiscussed: true,
    },
    preVitals: blankVitals(),
    postVitals: blankVitals(),
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
