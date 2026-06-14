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

// Mined 2026-06-13 by scripts/iv-mine-doses.ts (modal Standard-Dose answer per
// product across 55 historical IV notes). Keys are FULL template row labels
// (normalized) so standardDoseFor(row.label) matches at fill time. Only clean,
// reasonably-confident modes are included here; ambiguous/low-sample/free-text
// results were left OUT pending Alex's clinical confirmation (see the script
// output + the session notes — e.g. PC base 2500mg-vs-5g tie, Vit C 10g-vs-50g,
// Taurine/Alpha-Lipoic-Acid/Amino-Acid-Blend had no reliable history). Re-run the
// miner to refresh; add confirmed values below.
const RAW: Record<string, string> = {
  // High confidence (strong modal, multiple samples)
  "Glutathione 200 mg/mL (2.5 - 10 ml + 10 ml D5W)": "2 grams", // 8/15
  "Potassium Bicarbonate 99mg/capsule (2 - 3 capsules)": "99mg", // 6/9
  "Leucovorin 10mg/ml (mixed with bacteriostatic water)": "30mg", // 5/7
  "Phosphatidylcholine Push 50mg/ml (10 - 15 ml + 20 ml D5W)": "500mg", // 5/7
  "Methylcobalamin {B12} 10mg/ml (5mg-10mg)": "10mg", // 4/6
  // Single-protocol products (clean dose, smaller sample)
  "Carnitine 500mg/ml": "10mL",
  "Ascorbic Acid 500mg/ml": "10mL",
  "Magnesium 200mg/ml": "4mL",
  "Trace Minerals": "5mL",
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
