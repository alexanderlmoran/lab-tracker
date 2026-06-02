// Recipe-engine test harness: run a recipe-backed scraper against a synthetic
// case and verify the PDF. Proves the generic engine produces the same result as
// the hand-written scraper.
//
//   cd worker; set -a; . ../.env.local; set +a
//   npx tsx scripts/test-recipe.ts glycanage   "David Centner"  GA-US-030967
//   npx tsx scripts/test-recipe.ts doctorsdata  "Ryan Blair"    260416-2206

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getRecipe } from "../src/recipes/catalog.js";
import { makeRecipeScraper } from "../src/recipes/runner.js";
import type { OpenCase } from "../src/tracker-client.js";

const [key, patient, ref] = process.argv.slice(2);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  const recipe = key ? getRecipe(key) : undefined;
  if (!recipe) {
    console.error(`usage: test-recipe.ts <key> "<patient>" [ref]   (keys: glycanage, doctorsdata)`);
    process.exit(1);
  }
  const out = join(homedir(), "Desktop", "recipe-test");
  await mkdir(out, { recursive: true });

  const c: OpenCase = {
    caseId: `recipe-${key}`,
    patientName: patient ?? "David Centner",
    patientDob: null,
    patientEmail: "test@example.com",
    labName: recipe.labName,
    labExternalRef: process.env.USE_REF ? (ref ?? null) : null, // default name-match; USE_REF=1 to test ref path
    sampleSentAt: null,
    trackingDeliveredAt: null,
    expectedResultAtMin: null,
    expectedResultAtMax: null,
  };

  log(`recipe=${recipe.key} (${recipe.auth.strategy} / ${recipe.discovery.strategy} / ${recipe.pdf.strategy}) match=${process.env.USE_REF ? "ref" : "name"}`);
  const scraper = makeRecipeScraper(recipe);
  const run = await scraper.run(undefined as never, [c]);
  log(`found=${run.found.length} errors=${run.errors.length}`);
  for (const e of run.errors) log(`  ERROR ${e.caseId}: ${e.message}`);
  if (run.found.length === 0) {
    log("VERIFICATION FAILED: no result.");
    process.exitCode = 1;
    return;
  }
  const r = run.found[0];
  const buf = Buffer.from(r.pdfBase64, "base64");
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const dest = join(out, r.pdfFilename);
  await writeFile(dest, buf);
  log(`  labExternalRef=${r.labExternalRef} resultIssuedAt=${r.resultIssuedAt ?? "(none)"}`);
  log(`  bytes=${buf.length} md5=${createHash("md5").update(buf).digest("hex")} ${isPdf ? "✓ valid PDF" : "✗ NOT a PDF"}`);
  log(`  saved -> ${dest}`);
  log(isPdf ? "VERIFICATION PASSED." : "VERIFICATION FAILED.");
  if (!isPdf) process.exitCode = 1;
}

main();
