// END-TO-END verification of the IV note POST path against the pre-authorized
// test patient (Leila). Unlike pb-sessionnote-fill-test.ts (which hand-builds
// content), this runs the REAL production functions:
//
//   getSessionNote(ref) → scaffoldFromNote → buildIvNoteContent(sampleChart)
//   → ivNoteTitle → createSessionNote → getSessionNote(readback) → assert
//
// SAFE BY DEFAULT: a bare run is a DRY RUN — it logs in, reads the reference
// note, builds the content, and prints exactly what WOULD be posted. It writes
// NOTHING. Pass IV_VERIFY_COMMIT=1 to actually create the note on Leila, then
// read it back and verify every section + that no reference lot leaked.
//
// Run (dry):     cd worker && npx tsx scripts/iv-verify-post.ts
// Run (commit):  cd worker && IV_VERIFY_COMMIT=1 npx tsx scripts/iv-verify-post.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import {
  getSessionNote,
  scaffoldFromNote,
  createSessionNote,
  deleteSessionNote,
} from "../src/uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, ivNoteTitle, type IvChartInput } from "../src/iv/build-note-content.js";

loadEnvLocal();
const U = process.env.PB_USERNAME;
const P = process.env.PB_PASSWORD;
const LEILA = process.env.PB_TEST_PATIENT_ID || "641868664a3099220158325b";
const REF_NOTE = process.env.IV_VERIFY_REF_NOTE || "6a272b54271793958adbbdc2";
const COMMIT = process.env.IV_VERIFY_COMMIT === "1";
if (!U || !P) throw new Error("PB_USERNAME + PB_PASSWORD required");

// Known lot numbers baked into the reference note's question defs — NONE of
// these may appear in the note we post (proves the sanitize fix).
const REF_LOTS = ["1599728", "A905-01", "294020A", "2430301-1", "1576396", "1590513"];

// Distinctive TEST values so a read-back is unambiguous (and obviously not PHI).
const SAMPLE_CHART: IvChartInput = {
  assessment: {
    initialCheckIn: true,
    risksDiscussed: true,
    consentSigned: true,
    intakeSigned: true,
    historyDiscussed: true,
  },
  preVitals: { bp: "118/76", spo2: "98", temp: "98.4", hr: "68", resp: "14" },
  postVitals: { bp: "121/79", spo2: "99", temp: "98.7", hr: "71", resp: "16" },
  ivStart: { cath: "22" },
  attempts: "1",
  location: "right_antecubital",
  infusionFlowingWell: true,
  components: [
    { name: "Vitamin C", standardDose: "500mg/ml", addOnDose: "", lot: "VITC-TEST-1", exp: "2027-12" },
    { name: "Magnesium Chloride", standardDose: "200mg/ml", addOnDose: "100mg", lot: "MAG-TEST-2", exp: "2028-03" },
  ],
  imMedication: { name: "Methylcobalamin B12", dose: "IM-TEST-10mg", location: "left deltoid" },
  imShotGiven: true,
  infusionReaction: { occurred: false },
  ivRemoval: true,
  notes: "Automated IV-charting verification — safe to delete.",
};

const lc = (s?: string) => (s ?? "").toLowerCase();

async function main() {
  const pb = await pbLogin(U!, P!);
  console.log("✓ PB session established");

  const ref = await getSessionNote(pb, REF_NOTE);
  const scaffold = scaffoldFromNote(ref);
  console.log(`✓ reference note ${REF_NOTE} → ${scaffold.length} scaffold item(s) (sanitized)`);

  const content = buildIvNoteContent(scaffold, SAMPLE_CHART);
  const title = ivNoteTitle({ serviceName: "IV - Immune Boost", templateHint: "IV - Immune Boost", kind: "standard" });

  // Pre-flight leak check on what we're ABOUT to send.
  const outboundJson = JSON.stringify(content);
  const leakedOutbound = REF_LOTS.filter((lot) => outboundJson.includes(lot));

  console.log(`\n── PLAN ──────────────────────────────────────────────`);
  console.log(`  target patient : Leila (test) ${LEILA}`);
  console.log(`  note title     : TEST – ${title} (safe to delete)`);
  console.log(`  publishStatus  : draft  (never reaches the client portal)`);
  console.log(`  content items  : ${content.length}`);
  console.log(`  outbound lot leak: ${leakedOutbound.length ? "❌ " + leakedOutbound.join(",") : "✅ none"}`);
  console.log(`──────────────────────────────────────────────────────`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing was written. Re-run with IV_VERIFY_COMMIT=1 to post + verify.");
    return;
  }

  const created = await createSessionNote(pb, {
    clientRecordId: LEILA,
    name: `TEST – ${title} (safe to delete)`,
    summary: "IV-charting end-to-end verification",
    sessionDate: new Date().toISOString(),
    content,
  });
  console.log(`\n✓ CREATED note id=${created.id}  contentCount=${created.contentCount}`);

  // ── Read back and assert ────────────────────────────────────────────────
  const back = await getSessionNote(pb, created.id);
  const bc = back.content ?? [];
  const find = (re: RegExp, obj?: string) =>
    bc.find((c) => re.test(lc(c.question?.title)) && (!obj || c.question?.object === obj)) as any;
  const rowCells = (item: any) => (item?.answer?.answers ?? []).map((a: any) => a.cells);
  const trueCols = (cells: any[]) => cells.map((c) => c?.indexOf?.("True") ?? -1);

  const checks: Array<[string, boolean, string]> = [];

  const assess = find(/initial assessment/, "singlechoicegrid");
  const aAns = (assess?.answer?.answers ?? []).map((a: any) => a.answer);
  checks.push(["Initial Assessment all checked", aAns.length > 0 && aAns.every((x: number) => x === 0), JSON.stringify(aAns)]);

  const pre = find(/pre.?infusion vitals/, "matrix");
  const preCells = rowCells(pre).map((c: any[]) => c?.[0]);
  checks.push(["Pre vitals", preCells.includes("118/76") && preCells.includes("98.4"), JSON.stringify(preCells)]);

  const post = find(/post.?infusion vitals/, "matrix");
  const postCells = rowCells(post).map((c: any[]) => c?.[0]);
  checks.push(["Post vitals", postCells.includes("121/79") && postCells.includes("98.7"), JSON.stringify(postCells)]);

  const ivs = find(/iv start|catheter/, "singlechoicegrid");
  const ivAns = (ivs?.answer?.answers ?? []).map((a: any) => a.answer);
  checks.push(["IV Start catheter selected", ivAns.some((x: number) => x >= 0), JSON.stringify(ivAns)]);

  // Attempts / Location / flowing — selected cell should be "True".
  const att = find(/attempt|location/, "matrix");
  const attRows = att?.question?.rows ?? [];
  const attCells = rowCells(att);
  const sel = trueCols(attCells);
  const attemptsRow = attRows.findIndex((r: any) => /attempt/i.test(r.label));
  const locationRow = attRows.findIndex((r: any) => /location/i.test(r.label));
  const attemptOk = attemptsRow >= 0 && attCells[attemptsRow]?.[sel[attemptsRow]] === "True" &&
    lc((attRows[attemptsRow]?.cells?.[sel[attemptsRow]] as any)?.label) === "1";
  const locOk = locationRow >= 0 && /right antecubital/.test(lc((attRows[locationRow]?.cells?.[sel[locationRow]] as any)?.label));
  checks.push(["Attempts = 1 selected", attemptOk, `selCol=${sel[attemptsRow]}`]);
  checks.push(["Location = R Antecubital selected", locOk, `selCol=${sel[locationRow]}`]);

  // Components — rows rebuilt from the form, with our dose/lot values.
  const comp = bc.find((c) => /fluid/i.test(c.question?.title ?? "") && !/\bim\b/i.test(c.question?.title ?? "")) as any;
  const compLabels = (comp?.question?.rows ?? []).map((r: any) => r.label);
  const compFlat = JSON.stringify(rowCells(comp));
  const compOk =
    compLabels.includes("Vitamin C") && compLabels.includes("Magnesium Chloride") &&
    compFlat.includes("VITC-TEST-1") && compFlat.includes("200mg/ml + 100mg");
  checks.push(["Components rebuilt from form", compOk, JSON.stringify(compLabels)]);

  // Reaction = NO; Removal = YES.
  const rxn = find(/infusion reaction/, "matrix");
  const rxnSel = trueCols(rowCells(rxn))[0];
  const rxnNoCol = (rxn?.question?.columns ?? []).findIndex((c: any) => /^no/i.test(c.label));
  checks.push(["Infusion reaction = NO", rxnSel === rxnNoCol && rxnSel >= 0, `selCol=${rxnSel} noCol=${rxnNoCol}`]);

  const rem = find(/removal/, "matrix");
  const remSel = trueCols(rowCells(rem))[0];
  const remYesCol = (rem?.question?.columns ?? []).findIndex((c: any) => /^yes/i.test(c.label));
  checks.push(["IV removal = YES", remSel === remYesCol && remSel >= 0, `selCol=${remSel} yesCol=${remYesCol}`]);

  // IM Medication rebuilt from the form + IM Shot Given = YES.
  const imMed = bc.find((c) => /im medication|intramuscular/i.test(c.question?.title ?? "") && !/shot given/i.test(c.question?.title ?? "")) as any;
  const imLabels = (imMed?.question?.rows ?? []).map((r: any) => r.label);
  const imFlat = JSON.stringify(rowCells(imMed));
  checks.push(["IM medication mapped", imLabels.includes("Methylcobalamin B12") && imFlat.includes("IM-TEST-10mg") && imFlat.includes("left deltoid"), JSON.stringify(imLabels)]);
  const imShot = find(/shot given/, "matrix");
  const imShotSel = trueCols(rowCells(imShot))[0];
  const imYesCol = (imShot?.question?.columns ?? []).findIndex((c: any) => /^yes/i.test(c.label));
  checks.push(["IM shot given = YES", imShotSel === imYesCol && imShotSel >= 0, `selCol=${imShotSel} yesCol=${imYesCol}`]);

  // No reference lot leaked into the posted note.
  const backJson = JSON.stringify(bc);
  const leaked = REF_LOTS.filter((lot) => backJson.includes(lot));
  checks.push(["No reference lot leaked", leaked.length === 0, leaked.length ? leaked.join(",") : "clean"]);

  console.log(`\n── READ-BACK VERIFICATION (note ${created.id}) ─────────`);
  let allPass = true;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "✅" : "❌"} ${label}  ${detail}`);
    if (!pass) allPass = false;
  }
  console.log(`──────────────────────────────────────────────────────`);
  console.log(allPass ? `\n✅ PASS — full production post path verified.` : `\n❌ FAIL — see mismatches above.`);

  // Auto-clean the test note (we have the delete API now).
  try {
    await deleteSessionNote(pb, created.id);
    console.log(`🧹 deleted test note ${created.id}`);
  } catch (e) {
    console.log(`⚠ could not delete test note ${created.id}: ${e instanceof Error ? e.message : e} — delete in PB UI`);
  }
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
