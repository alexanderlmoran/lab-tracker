// Canonical lab catalog. Source of truth for the lab-name combobox, CSV
// import normalization (Lab Shipping sheet "Carrier" + Zenoti "Item Name"),
// and turnaround-based result-date prediction.
//
// Naming conventions in lab_cases.lab_name / lab_panel:
//   lab_name  = provider canonical short name ("Vibrant", "DoctorsData")
//   lab_panel = sub-panel display string, including category prefix when
//               present in the source ("Panel - PFAS Chemical",
//               "Zoomer - Gut", "Add-On - MTHFR"); null when the provider
//               has no sub-panel ("Cyrex", "Genova").
//
// Aliases cover spelling variants seen in source data (Zenoti / Lab Shipping
// sheet) so the import doesn't need fuzzy matching — exact lookup against
// alias list normalized via `normalizeLabKey()`.

export type LabCatalogEntry = {
  /** Canonical full display name. Stable across renames; used as the dropdown label. */
  name: string;
  /** Maps to lab_cases.lab_name. */
  provider: string;
  /** Maps to lab_cases.lab_panel. null when provider has no sub-panel. */
  panel: string | null;
  /** Min business-day turnaround from step 1 (sample sent) to step 4 (complete result received). null = unknown. */
  turnaroundDaysMin: number | null;
  turnaroundDaysMax: number | null;
  /** Retired panels still imported for historical rows but greyed in dropdown. */
  retired?: boolean;
  /** Default for whether this lab returns partial results before the complete
   * panel. Used to pre-tick the "partial expected" checkbox on new cases.
   * Only Access Blood Panel is true by default at time of writing. */
  partialExpected?: boolean;
  /** Spelling variants matched by normalizeLabKey() — case/whitespace/punctuation insensitive. */
  aliases?: string[];
  /** Expected FedEx destination city for delivery-verification. Compared
   * (case-insensitive, substring) against `tracking_location` on cases that
   * report `delivered`. When set and mismatched, the card raises a "wrong
   * destination?" soft warning. Leave undefined to disable the check. */
  shippingCity?: string;
  /** Two-letter US state code paired with shippingCity. Display-only. */
  shippingState?: string;
};

export const LAB_CATALOG: LabCatalogEntry[] = [
  // ── Access ────────────────────────────────────────────────────────────
  { name: "Access Blood Panel", provider: "Access", panel: "Blood Panel", turnaroundDaysMin: 5, turnaroundDaysMax: 7, partialExpected: true, aliases: ["access", "Labs - Access Blood Panel"] },

  // ── CancerCheck ───────────────────────────────────────────────────────
  { name: "CancerCheck", provider: "CancerCheck", panel: null, turnaroundDaysMin: 28, turnaroundDaysMax: 42, aliases: ["cancer check", "Labs - CancerCheck"] },

  // ── Cyrex ─────────────────────────────────────────────────────────────
  { name: "Cyrex", provider: "Cyrex", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["cyrex", "cryex", "Labs - Cyrex"] },

  // ── DoctorsData ───────────────────────────────────────────────────────
  { name: "DoctorsData", provider: "DoctorsData", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["doctors data", "doctor's data"] },

  // ── Dutch ─────────────────────────────────────────────────────────────
  { name: "Dutch", provider: "Dutch", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["dutch"] },

  // ── G6PD ──────────────────────────────────────────────────────────────
  { name: "G6PD Deficiency", provider: "G6PD Deficiency", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - G6PD Deficiency"] },

  // ── Genova ────────────────────────────────────────────────────────────
  { name: "Genova", provider: "Genova", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["genova", "Labs - Genova"] },

  // ── GlycanAge ─────────────────────────────────────────────────────────
  { name: "GlycanAge", provider: "GlycanAge", panel: null, turnaroundDaysMin: 1, turnaroundDaysMax: 3, aliases: ["glycanage", "Labs - Glycanage"] },

  // ── GOLDA ─────────────────────────────────────────────────────────────
  { name: "GOLDA Hormone Profile (saliva + urine)", provider: "GOLDA", panel: "Hormone Profile (saliva + urine)", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - GOLDA, Hormone Profile (saliva + urine)"] },
  { name: "GOLDA Hormone Profile (saliva only)", provider: "GOLDA", panel: "Hormone Profile (saliva only)", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - GOLDA, Hormone Profile (saliva only)"] },

  // ── Kennedy Krieger ───────────────────────────────────────────────────
  { name: "Kennedy Krieger", provider: "Kennedy Krieger", panel: null, turnaroundDaysMin: 10, turnaroundDaysMax: 14, aliases: ["kennedy krieger", "kennedy krieger (kk)", "kk", "Labs - Kennedy Krieger"] },

  // ── L2Bio ─────────────────────────────────────────────────────────────
  { name: "L2Bio", provider: "L2Bio", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["l2bio"] },

  // ── Life Length ───────────────────────────────────────────────────────
  { name: "Life Length", provider: "Life Length", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["life length"] },

  // ── Members Panel (in-house?) ─────────────────────────────────────────
  { name: "Members Panel", provider: "Members Panel", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Members Panel"] },

  // ── Peptides (in-house) ───────────────────────────────────────────────
  { name: "Peptides", provider: "Peptides", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Peptides"] },

  // ── Practice Blood Draw ───────────────────────────────────────────────
  { name: "Practice Blood Draw", provider: "Practice Blood Draw", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Practice Blood Draw"] },

  // ── Prodrome ──────────────────────────────────────────────────────────
  { name: "Prodrome", provider: "Prodrome", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["prodrome"] },

  // ── ReliGen ───────────────────────────────────────────────────────────
  { name: "ReliGen", provider: "ReliGen", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["religen"] },

  // ── RGCC ──────────────────────────────────────────────────────────────
  { name: "RGCC", provider: "RGCC", panel: null, turnaroundDaysMin: 14, turnaroundDaysMax: 28, aliases: ["rgcc", "Labs - RGCC"] },

  // ── Self Collection & Dispatch (service, not a lab) ───────────────────
  { name: "Self Collection & Dispatch", provider: "Self Collection & Dispatch", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Self Collection & Dispatch"] },

  // ── Spectracell ───────────────────────────────────────────────────────
  { name: "Spectracell (with Interpretation)", provider: "Spectracell", panel: "with Interpretation", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["spectracell", "Labs - Spectracell (w. Interpretation)"] },

  // ── TruAge ────────────────────────────────────────────────────────────
  { name: "TruAge", provider: "TruAge", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["trueage", "true age"] },

  // ── Vibrant — Panel ───────────────────────────────────────────────────
  { name: "Vibrant Panel - PFAS Chemical", provider: "Vibrant", panel: "Panel - PFAS Chemical", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Panel - PFAS Chemical"] },
  { name: "Vibrant Panel - Nutrient Intracellular", provider: "Vibrant", panel: "Panel - Nutrient Intracellular", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Panel - Nutrient Intracellular"] },
  { name: "Vibrant Panel - Nutrient Baseline", provider: "Vibrant", panel: "Panel - Nutrient Baseline", turnaroundDaysMin: 7, turnaroundDaysMax: 14, aliases: ["Labs - Vibrant Panel - Nutrient Baseline"] },
  { name: "Vibrant Panel - Oxidative Stress", provider: "Vibrant", panel: "Panel - Oxidative Stress", turnaroundDaysMin: 30, turnaroundDaysMax: 30, aliases: ["Labs - Vibrant Panel - Oxidative Stress"] },
  { name: "Vibrant Panel - Food Sensitivity Complete", provider: "Vibrant", panel: "Panel - Food Sensitivity Complete", turnaroundDaysMin: 7, turnaroundDaysMax: 7, aliases: ["Labs - Vibrant Panel - Food Sensitivity Complete"] },
  { name: "Vibrant Panel - Environmental Toxins", provider: "Vibrant", panel: "Panel - Environmental Toxins", turnaroundDaysMin: 7, turnaroundDaysMax: 7, aliases: ["Labs - Vibrant Panel - Environmental Toxins"] },
  { name: "Vibrant Panel - Mycotoxin Exposure", provider: "Vibrant", panel: "Panel - Mycotoxin Exposure", turnaroundDaysMin: 7, turnaroundDaysMax: 7, aliases: ["Labs - Vibrant Panel - Mycotoxin Exposure"] },
  { name: "Vibrant Panel - OATS (Organic Acids Test)", provider: "Vibrant", panel: "Panel - OATS (Organic Acids Test)", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Panel - OATS (Organic Acids Test)"] },
  { name: "Vibrant Panel - Tickborne 2.0", provider: "Vibrant", panel: "Panel - Tickborne 2.0", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Panel - Tickborne 2.0"] },
  { name: "Vibrant Panel - Heavy Metals (urine)", provider: "Vibrant", panel: "Panel - Heavy Metals (urine)", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Panel - Heavy Metals (urine)"] },

  // ── Vibrant — uncategorized ──────────────────────────────────────────
  { name: "Vibrant - Total Immunoglobulins", provider: "Vibrant", panel: "Total Immunoglobulins", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant - Total Immunoglobulins"] },
  { name: "Vibrant - Total Tox (urine)", provider: "Vibrant", panel: "Total Tox (urine)", turnaroundDaysMin: 7, turnaroundDaysMax: 7, aliases: ["Labs - Vibrant - Total Tox (urine)", "total tox", "totaltox", "vibrant total tox", "vibrant - total tox", "toxin waster", "vibrant tox"] },
  { name: "Vibrant - Total Tox (urine) [retired]", provider: "Vibrant", panel: "Total Tox (urine) [retired]", turnaroundDaysMin: null, turnaroundDaysMax: null, retired: true, aliases: ["(retired) Labs - Vibrant - Total Tox (urine)"] },
  { name: "Vibrant - Auto-Immune", provider: "Vibrant", panel: "Auto-Immune", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant - Auto-Immune"] },
  { name: "Vibrant - Viral Infections", provider: "Vibrant", panel: "Viral Infections", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant - Viral Infections"] },
  { name: "Vibrant - EBOO Waste", provider: "Vibrant", panel: "EBOO Waste", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - EBOO Waste (Vibrant)"] },

  // ── Vibrant — Zoomer ─────────────────────────────────────────────────
  { name: "Vibrant Zoomer - Gut", provider: "Vibrant", panel: "Zoomer - Gut", turnaroundDaysMin: 7, turnaroundDaysMax: 10, aliases: ["Labs - Vibrant Zoomer - Gut"] },
  { name: "Vibrant Zoomer - Nutrient (Blood)", provider: "Vibrant", panel: "Zoomer - Nutrient (Blood)", turnaroundDaysMin: 14, turnaroundDaysMax: 17, aliases: ["Labs - Vibrant Zoomer - Nutrient (Blood)"] },
  { name: "Vibrant Zoomer - Hormone", provider: "Vibrant", panel: "Zoomer - Hormone", turnaroundDaysMin: 10, turnaroundDaysMax: 14, aliases: ["Labs - Vibrant Zoomer - Hormone"] },
  { name: "Vibrant Zoomer - Cellular", provider: "Vibrant", panel: "Zoomer - Cellular", turnaroundDaysMin: 10, turnaroundDaysMax: 14, aliases: ["Labs - VIbrant Zoomer - Cellular", "Labs - Vibrant Zoomer - Cellular"] },
  { name: "Vibrant Zoomer - Cardio", provider: "Vibrant", panel: "Zoomer - Cardio", turnaroundDaysMin: 10, turnaroundDaysMax: 14, aliases: ["Labs - Vibrant Zoomer - Cardio"] },
  { name: "Vibrant Zoomer - Neural", provider: "Vibrant", panel: "Zoomer - Neural", turnaroundDaysMin: 14, turnaroundDaysMax: 17, aliases: ["Labs - Vibrant Zoomer - Neural"] },
  { name: "Vibrant Zoomer - Immune", provider: "Vibrant", panel: "Zoomer - Immune", turnaroundDaysMin: 7, turnaroundDaysMax: 10, aliases: ["Labs - Vibrant Zoomer - Immune"] },
  { name: "Vibrant Zoomer - Foundational", provider: "Vibrant", panel: "Zoomer - Foundational", turnaroundDaysMin: 10, turnaroundDaysMax: 14, aliases: ["Labs - Vibrant Zoomer - Foundational"] },
  { name: "Vibrant Zoomer - Toxin", provider: "Vibrant", panel: "Zoomer - Toxin", turnaroundDaysMin: 7, turnaroundDaysMax: 10, aliases: ["Labs - Vibrant Zoomer - Toxin"] },
  { name: "Vibrant Zoomer - Food", provider: "Vibrant", panel: "Zoomer - Food", turnaroundDaysMin: 7, turnaroundDaysMax: 10, aliases: ["Labs - Vibrant Zoomer - Food"] },

  // ── Vibrant — Zoomer Add-On ──────────────────────────────────────────
  { name: "Vibrant Zoomer Add-On - Methylation Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Methylation Genetics", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Zoomer Add-On - Methylation Genetics"] },
  { name: "Vibrant Zoomer Add-On - Antioxidant Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Antioxidant Genetics", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Zoomer Add-on - Antioxidant Genetics"] },
  { name: "Vibrant Zoomer Add-On - Cardio Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Cardio Genetics", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Zoomer Add-On - Cardio Genetics"] },
  { name: "Vibrant Zoomer Add-On - Celiac Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Celiac Genetics", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Zoomer Add-On - Celiac Genetics"] },
  { name: "Vibrant Zoomer Add-On - Nutrient Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Nutrient Genetics", turnaroundDaysMin: 7, turnaroundDaysMax: 7, aliases: ["Labs - Vibrant Zoomer Add-On - Nutrient Genetics"] },
  { name: "Vibrant Zoomer Add-On - Toxin Genetics", provider: "Vibrant", panel: "Zoomer Add-On - Toxin Genetics", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Zoomer Add-On - Toxin Genetics"] },

  // ── Vibrant — Add-On ──────────────────────────────────────────────────
  { name: "Vibrant Add-On - Factor II-V", provider: "Vibrant", panel: "Add-On - Factor II-V", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Add-on - Factor II-V"] },
  { name: "Vibrant Add-On - MTHFR", provider: "Vibrant", panel: "Add-On - MTHFR", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Add-on - MTHFR"] },
  { name: "Vibrant Add-On - ApoE", provider: "Vibrant", panel: "Add-On - ApoE", turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Vibrant Add-on - ApoE"] },

  // ── Vibrant (top-level, for Lab Shipping where panel is unknown) ─────
  { name: "Vibrant (panel unspecified)", provider: "Vibrant", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["vibrant", "Labs - Vibrant"] },

  // ── Viome ─────────────────────────────────────────────────────────────
  { name: "Viome", provider: "Viome", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["viome"] },

  // ── Mobile Phlebotomy (service) ───────────────────────────────────────
  { name: "Mobile Phlebotomy", provider: "Mobile Phlebotomy", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Mobile Phlebotomy"] },

  // ── Custom (free-form fallback) ───────────────────────────────────────
  { name: "Custom", provider: "Custom", panel: null, turnaroundDaysMin: null, turnaroundDaysMax: null, aliases: ["Labs - Custom", "Labs"] },
];

/**
 * Currently-offered peptides. Surfaced as a dropdown when the user selects
 * "Peptides" as the lab in the new-case form; the chosen value lands in
 * lab_panel so it flows into patient-facing emails verbatim. Edit this list
 * (or override per-row by typing free text — the input is a datalist, not a
 * strict select) when offerings change.
 */
export const PEPTIDES_OFFERED: string[] = [
  "BPC-157",
  "TB-500 (Thymosin Beta-4)",
  "CJC-1295",
  "Ipamorelin",
  "CJC-1295 / Ipamorelin",
  "Sermorelin",
  "Tesamorelin",
  "Semaglutide",
  "Tirzepatide",
  "GHK-Cu (Copper Peptide)",
  "MOTS-c",
  "Epitalon",
  "NAD+",
  "Selank",
  "Semax",
  "DSIP",
  "PT-141",
];

/**
 * Normalize a lab key for alias matching: lowercase, collapse whitespace,
 * strip surrounding/internal punctuation noise. Used for both source-string
 * lookup and alias storage.
 */
export function normalizeLabKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(retired\)/g, "")
    .replace(/\s*-\s*/g, " - ")
    .replace(/[\s ]+/g, " ")
    .trim();
}

const ALIAS_INDEX: Map<string, LabCatalogEntry> = (() => {
  const m = new Map<string, LabCatalogEntry>();
  for (const e of LAB_CATALOG) {
    m.set(normalizeLabKey(e.name), e);
    for (const a of e.aliases ?? []) {
      m.set(normalizeLabKey(a), e);
    }
  }
  return m;
})();

/**
 * Look up a catalog entry by raw source string ("Labs - Vibrant Zoomer - Gut",
 * "vibrant", "Cyrex"). Returns null if no match. Case-insensitive, whitespace-
 * tolerant; strips "(retired)" prefix.
 */
export function findLabByName(raw: string): LabCatalogEntry | null {
  if (!raw) return null;
  return ALIAS_INDEX.get(normalizeLabKey(raw)) ?? null;
}

/**
 * Flattened (alias -> canonical name) list for downstream consumers like the
 * AI normalize prompt. Skips the canonical name itself (already passed as a
 * known_label) to keep the payload short.
 */
export function getLabAliasPairs(): Array<{ alias: string; canonical: string }> {
  const out: Array<{ alias: string; canonical: string }> = [];
  for (const e of LAB_CATALOG) {
    const canonicalKey = normalizeLabKey(e.name);
    for (const a of e.aliases ?? []) {
      if (normalizeLabKey(a) === canonicalKey) continue;
      out.push({ alias: a, canonical: e.name });
    }
  }
  return out;
}

/**
 * Lab destination ("ships to") lookup. Returns the catalog's stored city +
 * state if known; null otherwise. Provider-level fallback: if a sub-panel
 * entry has no address but another entry under the same provider does, use
 * that — addresses don't differ per-panel at a single lab.
 */
export function getLabDestination(
  labName: string,
  labPanel?: string | null,
): { city: string; state: string } | null {
  const direct = labPanel
    ? findLabByName(`${labName} ${labPanel}`) ?? findLabByName(labName)
    : findLabByName(labName);
  if (direct?.shippingCity) {
    return {
      city: direct.shippingCity,
      state: direct.shippingState ?? "",
    };
  }
  // Provider-level fallback: any sibling under the same provider with an
  // address counts. Avoids requiring duplicated city/state per panel row.
  const sibling = LAB_CATALOG.find(
    (e) =>
      e.provider === (direct?.provider ?? labName) && e.shippingCity,
  );
  if (sibling?.shippingCity) {
    return {
      city: sibling.shippingCity,
      state: sibling.shippingState ?? "",
    };
  }
  return null;
}

/**
 * "Does this delivered tracking location match where the lab actually lives?"
 * Returns null when we can't tell (no expected city on file, no FedEx
 * location reported, or status isn't delivered). Returns a warning string
 * when we have both pieces and they don't agree.
 *
 * Match is intentionally loose — FedEx returns location strings like
 * "MEMPHIS TN" or "WEST PALM BEACH FL"; we just substring-check the expected
 * city against the location, case-insensitively.
 */
export function trackingDestinationWarning(args: {
  labName: string;
  labPanel: string | null;
  trackingStatus: string | null;
  trackingLocation: string | null;
}): string | null {
  if (args.trackingStatus !== "delivered") return null;
  if (!args.trackingLocation) return null;
  const dest = getLabDestination(args.labName, args.labPanel);
  if (!dest) return null;
  const loc = args.trackingLocation.toLowerCase();
  const city = dest.city.toLowerCase();
  if (loc.includes(city)) return null;
  return `Delivered to "${args.trackingLocation}" but ${args.labName} is in ${dest.city}${dest.state ? `, ${dest.state}` : ""}`;
}

/**
 * Compute an expected result-date range from a step1_sample_sent_at date and a
 * lab catalog entry. Returns nulls when the entry has no turnaround estimate.
 */
export function predictResultDates(
  sampleSentAt: Date,
  entry: LabCatalogEntry,
): { minIso: string | null; maxIso: string | null } {
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const min = entry.turnaroundDaysMin;
  const max = entry.turnaroundDaysMax;
  if (min == null && max == null) return { minIso: null, maxIso: null };
  const start = new Date(sampleSentAt);
  const minDate = min != null ? new Date(start.getTime() + min * 86_400_000) : null;
  const maxDate = max != null ? new Date(start.getTime() + max * 86_400_000) : null;
  return {
    minIso: minDate ? toIso(minDate) : null,
    maxIso: maxDate ? toIso(maxDate) : null,
  };
}
