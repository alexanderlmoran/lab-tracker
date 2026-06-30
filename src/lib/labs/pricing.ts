// Lab pricing — what the clinic SELLS each lab for (revenue) and roughly what it
// COSTS the clinic (for margin). Sell prices are transcribed from the Zenoti
// service catalog (the authoritative configured prices, Alex 2026-06-30); costs
// are from the lab catalogs (Cyrex/Vibrant) + Alex's estimates and are
// APPROXIMATE. Used by /labs/analytics.
//
// A case is priced in layers (see resolveSell):
//   1. exact zenoti_service_name (covers the ~23% of cases that carry one)
//   2. lab_name + lab_panel
//   3. lab_name alone (coarse — a generic "Vibrant" with no panel can't be
//      pinned to one of its many prices, so it's flagged 'lab' / left unpriced)
// Everything normalizes case-insensitively and trims the "(w. Interpretation)"
// style suffixes the data carries.

export type PriceBasis = "service" | "panel" | "lab" | "unknown";
export type PricedCase = {
  lab_name: string | null;
  lab_panel?: string | null;
  zenoti_service_name?: string | null;
};

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\(w\.?\s*interpretation\)/g, "")
    .replace(/[·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── SELL: exact Zenoti service name → price (USD) ──────────────────────────
// Keys are normalized service names ("labs - vibrant zoomer - gut").
const SELL_BY_SERVICE: Record<string, number> = {
  "labs - access blood panel": 800,
  "labs - access custom": 0,
  "labs - cancercheck": 2000,
  "labs - cyrex custom": 0,
  "labs - cyrex food sensitivity": 400,
  "labs - cyrex lymphocyte map": 600,
  "labs - cyrex wheatburden": 405,
  "labs - doctor's data": 200,
  "labs - eboo waste (vibrant)": 750,
  "labs - g6pd deficiency": 50,
  "labs - genova": 765,
  "labs - glycanage": 350,
  "labs - golda, hormone profile (saliva + urine)": 2200,
  "labs - golda, hormone profile (saliva only)": 1500,
  "labs - kennedy krieger": 610,
  "labs - life length": 600,
  "labs - members panel": 150,
  "labs - mitoswab": 525,
  "labs - mobile phlebotomy": 0,
  "labs - peptides": 300,
  "labs - rgcc": 4200,
  "labs - self collection & dispatch": 0,
  "labs - spectracell": 800,
  "labs - vibrant - tickborne 2.0": 1500,
  "labs - vibrant - total immunoglobulins": 0,
  "labs - vibrant - total tox (urine)": 825,
  "labs - vibrant - viral infections": 600,
  "labs - vibrant panel - environmental toxins": 480,
  "labs - vibrant panel - food sensitivity complete": 750,
  "labs - vibrant panel - heavy metals (urine)": 270,
  "labs - vibrant panel - mycotoxin exposure": 600,
  "labs - vibrant panel - nutrient baseline": 675,
  "labs - vibrant panel - nutrient intracellular": 600,
  "labs - vibrant panel - oats (organic acids test)": 405,
  "labs - vibrant panel - oxidative stress": 600,
  "labs - vibrant panel - pfas chemical": 450,
  "labs - vibrant zoomer - cardio": 900,
  "labs - vibrant zoomer - cellular": 900,
  "labs - vibrant zoomer - food": 1050,
  "labs - vibrant zoomer - foundational": 900,
  "labs - vibrant zoomer - gut": 825,
  "labs - vibrant zoomer - hormone": 750,
  "labs - vibrant zoomer - immune": 600,
  "labs - vibrant zoomer - neural": 675,
  "labs - vibrant zoomer - nutrient (blood)": 900,
  "labs - vibrant zoomer - toxin": 1050,
};

// ── SELL fallback: lab_name + panel → price (for cases with no service name) ──
// Keys normalized "lab|panel". Mirrors the Zenoti list above by panel.
const SELL_BY_LAB_PANEL: Record<string, number> = {
  "access|blood panel": 800,
  "vibrant|total tox (urine)": 825,
  "vibrant|zoomer - gut": 825,
  "vibrant|zoomer - toxin": 1050,
  "vibrant|zoomer - foundational": 900,
  "vibrant|zoomer - neural": 675,
  "vibrant|zoomer - nutrient (blood)": 900,
  "vibrant|zoomer - cellular": 900,
  "vibrant|zoomer - immune": 600,
  "vibrant|zoomer - cardio": 900,
  "vibrant|zoomer - hormone": 750,
  "vibrant|zoomer - food": 1050,
  "vibrant|eboo waste": 750,
  "spectracell|with interpretation": 800,
};

// ── SELL last-resort: lab_name alone → representative price ─────────────────
// A generic "Vibrant"/"Cyrex"/"Access" with NO panel can't be pinned to one of
// the lab's many prices, so it is intentionally absent here → resolveSell flags
// it 'lab' with the listed value where one representative price is safe, else
// unknown. Only labs with a single product (or a clear default) get an entry.
const SELL_BY_LAB: Record<string, number> = {
  "kennedy krieger": 610,
  kennedykrieger: 610,
  doctorsdata: 200,
  "doctor's data": 200,
  glycanage: 350,
  rgcc: 4200,
  genova: 765,
  mitoswab: 525,
  peptides: 300,
  cancercheck: 2000,
  "life length": 600,
  "members panel": 150,
  "mobile phlebotomy": 0,
  "self collection & dispatch": 0,
  "access custom": 0,
  "cyrex custom": 0,
  access: 800, // generic Access → Blood Panel (the common case)
  spectracell: 800,
};

// ── COST (what the clinic pays the lab) — APPROXIMATE, by lab_name ──────────
// From the lab catalogs (Cyrex/Vibrant) + Alex's estimates. Coarse: used only
// for a margin ESTIMATE, flagged as approximate in the UI.
const COST_BY_LAB: Record<string, number> = {
  access: 550,
  "access custom": 0,
  cancercheck: 1000,
  "kennedy krieger": 425,
  kennedykrieger: 425,
  "members panel": 64,
  mitoswab: 350,
  rgcc: 2000,
  spectracell: 300,
  glycanage: 0,
  doctorsdata: 0,
  "doctor's data": 0,
  peptides: 0,
  // Vibrant/Cyrex costs vary by panel; left 0 here (margin shown only where known).
};

export type PriceResult = { amount: number; basis: PriceBasis };

/** What the clinic sells this case for, with how it was resolved. */
export function resolveSell(c: PricedCase): PriceResult {
  const svc = norm(c.zenoti_service_name);
  if (svc && svc in SELL_BY_SERVICE) return { amount: SELL_BY_SERVICE[svc], basis: "service" };

  const lab = norm(c.lab_name);
  const panel = norm(c.lab_panel);
  if (lab && panel) {
    const k = `${lab}|${panel}`;
    if (k in SELL_BY_LAB_PANEL) return { amount: SELL_BY_LAB_PANEL[k], basis: "panel" };
    // a panel that's itself a known service ("vibrant" + "zoomer - x")
    const svcGuess = `labs - ${lab} ${panel}`.replace(/\s+/g, " ");
    if (svcGuess in SELL_BY_SERVICE) return { amount: SELL_BY_SERVICE[svcGuess], basis: "panel" };
  }
  if (lab && lab in SELL_BY_LAB) return { amount: SELL_BY_LAB[lab], basis: "lab" };
  return { amount: 0, basis: "unknown" };
}

/** Approximate clinic cost for this case (0 / unknown where not catalogued). */
export function resolveCost(c: PricedCase): number {
  const lab = norm(c.lab_name);
  return COST_BY_LAB[lab] ?? 0;
}

export function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
