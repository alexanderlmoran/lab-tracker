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

const RAW: Record<string, string> = {
  // Immune Boost (verified across recent notes; IV NS 0.9% 500ml + IV push + IM)
  "Vitamin C 500mg/ml": "20mL",
  "B-Complex": "2mL",
  "Magnesium Chloride 200mg/1ml": "2mL",
  "Zinc Chloride 10mg/ml": "1mL",
  "Glutathione 200mg/ml": "2.5mL",
  "Vitamin D 50,000 IU (1ml)": "1mL",
};

export const COMPONENT_DOSES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [norm(k), v]),
);

/** Standard dose for a product (by its matrix row label), or null if unknown. */
export function standardDoseFor(productLabel: string | undefined | null): string | null {
  if (!productLabel) return null;
  return COMPONENT_DOSES[norm(productLabel)] ?? null;
}
