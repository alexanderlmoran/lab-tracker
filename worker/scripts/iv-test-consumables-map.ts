// Unit test for consumablesToComponents (the Zenoti consumables → chart mapping).
// Uses the real shapes captured from Leila's PC GetAppointmentProducts response.
// Run: cd worker && npx tsx scripts/iv-test-consumables-map.ts
import { consumablesToComponents, type AppointmentProduct } from "../src/zenoti/fetch-browser.js";

const sample: AppointmentProduct[] = [
  { name: "Essentiale PC - Standard (1unts)", unitsUsed: "22", volumeType: "unts", volumePerItem: 1, tracking: "manual" },
  { name: "Glutathione 200MG/ML (1ml)", unitsUsed: "10", volumeType: "ml", volumePerItem: 1, tracking: "manual" },
  { name: "Leucovorin (1mg)", unitsUsed: "30", volumeType: "mg", volumePerItem: 1, tracking: "manual" },
  { name: "Sodium Phenylbutyrate PF 200 MG/ML (1ml)", unitsUsed: "2.5", volumeType: "ml", volumePerItem: 1, tracking: "manual" },
  { name: "IV Bag | D5W 250ml (1unts)", unitsUsed: "2", volumeType: "unts", volumePerItem: 1, tracking: "auto" },
];

const out = consumablesToComponents(sample);
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };
const f = (name: string) => out.find((o) => o.name === name);
console.log(JSON.stringify(out, null, 1));
ok('PC: "Essentiale PC - Standard" std "22 units"', f("Essentiale PC - Standard")?.standardDose === "22 units");
ok('Glutathione: name stripped of (1ml), std "10 ml"', f("Glutathione 200MG/ML")?.standardDose === "10 ml");
ok('Leucovorin std "30 mg"', f("Leucovorin")?.standardDose === "30 mg");
ok('Sodium Phenylbutyrate std "2.5 ml"', f("Sodium Phenylbutyrate PF 200 MG/ML")?.standardDose === "2.5 ml");
ok('D5W bag std "2 units"', f("IV Bag | D5W 250ml")?.standardDose === "2 units");
ok("5 components mapped", out.length === 5);
console.log(`\n══ consumables-map: ${pass} passed, ${fail} failed ══`);
if (fail) process.exit(1);
