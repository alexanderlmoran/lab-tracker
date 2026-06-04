// Test the integrated Access probeByName (the code the Find-result button runs)
// against a patient by name. Read-only — no DB/PB writes.
//   cd worker && npx tsx scripts/test-access-probe-leila.ts
//   npx tsx scripts/test-access-probe-leila.ts "Fereshteh Krasowski" 1976-12-28
//
// Env must load BEFORE access.ts (which reads ACCESS_* at module load), so the
// scraper is dynamic-imported after loadEnvLocal().

import { chromium } from "playwright";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const { accessScraper } = await import("../src/scrapers/access.js");

const name = process.argv[2] ?? "Leila Centner";
const dob = process.argv[3] ?? "1976-12-28";

console.log(`probeByName("${name}", dob=${dob})…\n`);
const browser = await chromium.launch({ headless: true });
try {
  const t0 = Date.now();
  const cands = await accessScraper.probeByName!(browser, name, dob);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${cands.length} candidate(s) in ${secs}s:\n`);
  for (const c of cands) {
    console.log(
      `  acc=${(c.ref ?? "—").padEnd(11)} collected=${(c.collectionDate ?? "—").padEnd(11)} ` +
        `final=${(c.resultIssuedAt ?? "—").padEnd(11)} status=${c.status}`,
    );
  }
} catch (e) {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await browser.close();
}
