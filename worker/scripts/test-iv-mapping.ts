// Offline verification of classifyIvService against the full IV taxonomy from
// the appointments CSV (2026-06-09, 517 IVs / 31 distinct services).
// Run: npx tsx worker/scripts/test-iv-mapping.ts
import { classifyIvService, isIvService } from "../src/zenoti/iv-mapping.js";

// [service name, appointment count] — verbatim from Appointments.csv.
const SERVICES: Array<[string, number]> = [
  ["IV - EBOO Oxygenation & Ozone Therapy", 147],
  ["IV - EBO2 Therapy", 54],
  ["IV - Custom", 41],
  ["IV - Immune Boost", 37],
  ["IV - Glutathione Push (Add-on)", 23],
  ["IV - NR+ 250mg for Longevity & Mitochondrial Support", 22],
  ["IV - PC", 19],
  ["IV - Myers’ Cocktail", 19],
  ["IV - Wellness Warrior - Staff", 17],
  ["IV - (Add-on) Vitamin D3 injection", 17],
  ["IV - High-Dose Vitamin C (25g)", 16],
  ["IV - Methylene Blue (10 mg)", 14],
  ["IV - (Add-on) Vitamin B12", 12],
  ["IV - Weber", 11],
  ["IV - NR+ 500mg for Longevity & Mitochondrial Support", 10],
  ["IV - Athletic Performance", 8],
  ["IV - Brain Boost & Cognitive Support", 7],
  ["IV - Chelation + Weber", 7],
  ["IV - Wellness Warrior", 5],
  ["IV - Methylene Blue IV (20 mg)", 5],
  ["IV - Signature Cocktail", 4],
  ["IV - Luma Elite UVBI", 4],
  ["IV - Wellness Warrior - Centner Academy", 4],
  ["IV - High-Dose Vitamin C (50g)", 3],
  ["IV - PC SP", 3],
  ["IV - Curcumin 100mg", 1],
  ["IV - EDTA", 1],
  ["IV - DMPS", 1],
  ["IV - Methylene Blue IV (30 mg)", 1],
  ["IV - PC15 SP", 1],
  ["IV - Regenesis Stack", 1],
  ["IV - Beauty Boost Rejuvenation", 1],
  ["IV -  STAFF Myers' Cocktail", 1],
];

const tally: Record<string, number> = {};
let addons = 0;
let weber = 0;

console.log(
  "KIND".padEnd(9) +
    "ADD".padEnd(5) +
    "WEB".padEnd(5) +
    "CNT".padEnd(5) +
    "SERVICE  ->  templateHint",
);
console.log("-".repeat(100));

for (const [svc, cnt] of SERVICES) {
  const info = classifyIvService(svc);
  if (!info) {
    console.log(`!! NOT CLASSIFIED AS IV: ${svc}`);
    continue;
  }
  tally[info.kind] = (tally[info.kind] ?? 0) + cnt;
  if (info.isAddOn) addons += cnt;
  if (info.weber) weber += cnt;
  console.log(
    info.kind.padEnd(9) +
      (info.isAddOn ? "yes" : "·").padEnd(5) +
      (info.weber ? "yes" : "·").padEnd(5) +
      String(cnt).padEnd(5) +
      `${svc}  ->  ${info.templateHint}`,
  );
}

console.log("-".repeat(100));
console.log("Volume by kind:", tally);
console.log(`Add-on volume: ${addons}   Weber volume: ${weber}`);

// Sanity: non-IV services must NOT classify.
const negatives = ["Labs - Access", "Botox", "IV Therapy Consult", ""];
const leaks = negatives.filter((s) => isIvService(s));
console.log("Non-IV leak check (should be []):", leaks);
