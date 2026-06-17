// Standard component doses, mined from historical PB notes (the modal Standard
// Dose value per product). Used to auto-fill the Standard Dose column on a posted
// IV note so the template's products aren't left blank — staff still edit/override
// in the form. Keyed by NORMALIZED product label (lowercased, collapsed spaces),
// matched against the PB template's matrix row labels.
//
// Doses are concentration-based (the product label carries the concentration, so
// a given product's standard dose is the same across protocols). Extend this map
// as more protocols are mined — see scripts notes; PB rate-limits bulk fetching,
// so mine in small throttled batches or paste known protocol doses here.

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// FALLBACK ONLY. The PRIMARY source of a product's standard dose is the reference
// template's own "Standard Dose" cell (Brain Boost, Vit C 25g/50g, etc. carry it
// baked in — see catalogComponentsAnswer in build-note-content.ts, which prefers
// that cell). This catalog only fills templates whose dose cell is EMPTY — chiefly
// the base IV note, which puts the dose RANGE in the row LABEL ("Glutathione 200
// mg/mL (2.5-10ml…)") and leaves the cell blank.
//
// Mined 2026-06-13 by scripts/iv-mine-doses.ts (modal Standard-Dose answer per
// product across 55 historical IV notes). Keys are FULL template row labels
// (normalized) so standardDoseFor(row.label) matches at fill time.
//
// The old "gaps/conflicts" (Taurine/ALA/Amino-Acid-Blend, PC base 2500-vs-5g, Vit
// C 10g-vs-50g) are NOT resolved here: they were artifacts of mining one row label
// across different templates. Each template carries its own correct dose cell, so
// the template-cell-first path resolves them. PC base ("Phosphatidylcholine 50mg/ml
// (50-75 ml)…") is intentionally left blank — it's clinically directed per visit
// (5-22 amps), so staff enter it. Re-run the miner to refresh; add confirmed
// base-IV-only values below.
const RAW: Record<string, string> = {
  // High confidence (strong modal, multiple samples)
  "Glutathione 200 mg/mL (2.5 - 10 ml + 10 ml D5W)": "2 grams", // 8/15
  "Potassium Bicarbonate 99mg/capsule (2 - 3 capsules)": "99mg", // 6/9
  "Leucovorin 10mg/ml (mixed with bacteriostatic water)": "30mg", // 5/7
  "Phosphatidylcholine Push 50mg/ml (10 - 15 ml + 20 ml D5W)": "500mg", // 5/7
  "Methylcobalamin {B12} 10mg/ml (5mg-10mg)": "10mg", // 4/6
  // Single-protocol products (clean dose, smaller sample).
  // Doses are expressed as MASS (mg/mcg/g), not volume — only blends without a
  // single active concentration (Amino Acid Blend, Trace Minerals, B-Complex) stay
  // in mL. The conc-bearing products are converted from their historical mL dose:
  // Carnitine/Vit C 500mg/ml × 10mL = 5 g; Magnesium 200mg/ml × 4mL = 800 mg.
  "Carnitine 500mg/ml": "5 g",
  "Ascorbic Acid 500mg/ml": "5 g",
  "Magnesium 200mg/ml": "800 mg",
  "Trace Minerals": "5mL", // blend — dosed by volume (no single active conc)
  "Nicotinamide Riboside": "500mg",
  "NR": "500mg",
  "Curcumin 20mg/ml": "200mg",
  "EGCG": "50mg",
  "Quercetin 20mg/ml": "200mg",
  "B-Complex": "2mL",
  "Vitamin D 50,000 IU (1ml)": "50,000 IU",
};

export const COMPONENT_DOSES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [norm(k), v]),
);

/** Standard dose for a product (by its matrix row label), or null if unknown. */
export function standardDoseFor(productLabel: string | undefined | null): string | null {
  if (!productLabel) return null;
  return COMPONENT_DOSES[norm(productLabel)] ?? null;
}
