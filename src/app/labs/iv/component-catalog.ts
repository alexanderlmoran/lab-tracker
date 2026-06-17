// Canonical IV component catalog for the charting form's product picker.
//
// Each entry is one infusible product written in its CLINICAL wording (name +
// concentration) so the picked label reads correctly on the PB note, plus the
// modal Standard Dose where we know it. The form's <datalist> renders these
// (alphabetical) so staff can click-to-scroll or type to filter ("p" → "Phos…").
// Picking a product with a known dose auto-fills the Std-dose cell (staff still
// override per visit).
//
// Dose source: mirrors the mined doses in worker/src/iv/component-doses.ts
// (modal Standard-Dose per product across historical PB notes). Keep the two in
// sync — same product wording, same dose. Products without a confident mined
// dose are listed name-only (dose left blank, same "unknown → blank" philosophy
// as component-doses.ts); staff enter the dose. Extend freely as protocols grow.

export type IvComponent = {
  /** Clinical label — becomes the PB component-matrix row label when picked. */
  label: string;
  /** Modal standard dose, auto-filled on pick when the cell is empty. */
  standardDose?: string;
};

// Unsorted source list; exported sorted below.
const RAW: IvComponent[] = [
  { label: "Alpha Lipoic Acid (ALA) 50mg/ml" },
  { label: "Amino Acid Blend" },
  { label: "Arginine" },
  { label: "Ascorbic Acid (Vitamin C) 500mg/ml", standardDose: "5 g" },
  { label: "B-Complex", standardDose: "2mL" }, // blend — dosed by volume (like Amino Acids / Trace Minerals)
  { label: "Biotin" },
  { label: "Calcium Gluconate" },
  { label: "Carnitine 500mg/ml", standardDose: "5 g" },
  { label: "Curcumin 20mg/ml", standardDose: "200mg" },
  { label: "D5W (Dextrose 5%)" },
  { label: "EGCG", standardDose: "50mg" },
  { label: "Glutathione 200mg/ml", standardDose: "2 grams" },
  { label: "Hydroxocobalamin (B12)" },
  { label: "Leucovorin 10mg/ml", standardDose: "30mg" },
  { label: "Lysine" },
  { label: "Magnesium 200mg/ml", standardDose: "800 mg" },
  { label: "Methylcobalamin (B12) 10mg/ml", standardDose: "10mg" },
  { label: "NAD+" },
  { label: "Nicotinamide Riboside (NR)", standardDose: "500mg" },
  { label: "Normal Saline 0.9% (base fluid)" },
  { label: "Phosphatidylcholine (PC) Push 50mg/ml", standardDose: "500mg" },
  { label: "Potassium Bicarbonate 99mg/capsule", standardDose: "99mg" },
  { label: "Quercetin 20mg/ml", standardDose: "200mg" },
  { label: "Selenium" },
  { label: "Sterile / Bacteriostatic Water" },
  { label: "Taurine" },
  { label: "Trace Minerals", standardDose: "5mL" },
  { label: "Vitamin D 50,000 IU (1ml)", standardDose: "50,000 IU" },
  { label: "Zinc" },
];

/** The catalog, sorted alphabetically for the dropdown. */
export const IV_COMPONENTS: IvComponent[] = [...RAW].sort((a, b) =>
  a.label.localeCompare(b.label),
);

const BY_LABEL = new Map(IV_COMPONENTS.map((c) => [c.label, c]));

/** Catalog entry for an exact product label (the value the datalist inserts), or
 *  undefined for a free-typed product not in the catalog. */
export function componentForLabel(label: string): IvComponent | undefined {
  return BY_LABEL.get(label.trim());
}
