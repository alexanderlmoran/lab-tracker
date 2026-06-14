// Verify the empty-dose-bug FIX: when staff DON'T chart components, the posted
// note's "Standard Dose" column must carry the protocol dose — from the template's
// own cell (Brain Boost, Vit C 25g/50g) or, for the base IV note (empty cell, range
// in the row label), from the mined catalog. Lot #/Expiration/Add-On stay blank.
//
// Runs the REAL production path: getSessionNote(ref) → scaffoldFromNote →
// buildIvNoteContent(EMPTY chart) → catalogComponentsAnswer.
//
// SAFE BY DEFAULT: a bare run is a DRY RUN (reads templates, builds, prints, asserts
// — writes NOTHING). IV_VERIFY_COMMIT=1 posts ONE Brain Boost draft to Alex Moran so
// you can eyeball it in PB (left in place; not auto-deleted).
//
// Run (dry):    cd worker && npx tsx scripts/iv-verify-dose-fill.ts
// Run (commit): cd worker && IV_VERIFY_COMMIT=1 npx tsx scripts/iv-verify-dose-fill.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, findPbPatient } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote, createSessionNote } from "../src/uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, ivNoteTitle, type IvChartInput } from "../src/iv/build-note-content.js";

loadEnvLocal();
const U = process.env.PB_USERNAME, P = process.env.PB_PASSWORD;
if (!U || !P) throw new Error("PB_USERNAME + PB_PASSWORD required");
const COMMIT = process.env.IV_VERIFY_COMMIT === "1";

const REFS = [
  { hint: "Brain Boost & Cognitive Support", ref: "6a285d04855663b0b8278a8c", expectFilled: true },
  { hint: "Myers' Cocktail", ref: "6a19c806491ce448ab88b8a8", expectFilled: true },
  { hint: "High-Dose Vitamin C (25g)", ref: "69f8d06455266771c397472e", expectFilled: true },
  { hint: "High-Dose Vitamin C (50g)", ref: "6a1de3c36b61f836f2453d79", expectFilled: true },
  { hint: "Base IV (catalog fallback)", ref: "6a272b54271793958adbbdc2", expectFilled: true },
];

// Lots baked into reference note question-defs — none may appear in built output.
const REF_LOTS = ["1599728", "A905-01", "294020A", "2430301-1", "1576396", "1590513"];

// Staff charted NOTHING → exercises the catalog/template-cell dose-fill path.
const EMPTY_CHART: IvChartInput = {
  preVitals: { bp: "118/76", spo2: "98", temp: "98.4", hr: "68", resp: "14" },
};

const lc = (s?: string) => (s ?? "").toLowerCase();
type AnyItem = { question?: { title?: string; object?: string; columns?: Array<{ label?: string }>; rows?: Array<{ label?: string }> }; answer?: { answers?: Array<{ index: number; cells?: Array<string | null> }> } };

function isComponents(q: AnyItem["question"]): boolean {
  if (!q || q.object !== "matrix") return false;
  const t = lc(q.title);
  if (/vital|attempt|location|reaction|removal|shot given/.test(t)) return false;
  const cols = (q.columns ?? []).map((c) => lc(c.label));
  return cols.some((l) => /dose/.test(l)) && (cols.some((l) => /lot/.test(l)) || /fluid|intravenous|push/.test(t));
}

async function main() {
  const pb = await pbLogin(U!, P!);
  console.log("✓ PB session established\n");
  let allOk = true;

  for (const { hint, ref, expectFilled } of REFS) {
    const note = await getSessionNote(pb, ref);
    const content = buildIvNoteContent(scaffoldFromNote(note), EMPTY_CHART) as AnyItem[];
    const leak = REF_LOTS.filter((lot) => JSON.stringify(content).includes(lot));
    console.log(`■ ${hint}  (ref ${ref})`);

    let filledRows = 0, totalRows = 0;
    for (const item of content) {
      const q = item.question;
      if (!isComponents(q)) continue;
      const cols = (q!.columns ?? []).map((c) => lc(c.label));
      const stdIdx = cols.findIndex((l) => /standard dose/.test(l) || /^dose$/.test(l));
      const lotIdx = cols.findIndex((l) => /lot/.test(l));
      const expIdx = cols.findIndex((l) => /expir/.test(l));
      const byRow = new Map((item.answer?.answers ?? []).map((a) => [a.index, a.cells ?? []]));
      (q!.rows ?? []).forEach((row, i) => {
        const label = row.label ?? "";
        if (!label || /^\[enter/i.test(label)) return; // skip the add-on placeholder rows
        totalRows++;
        const cells = byRow.get(i) ?? [];
        const dose = stdIdx >= 0 ? cells[stdIdx] : null;
        const lot = lotIdx >= 0 ? cells[lotIdx] : null;
        const exp = expIdx >= 0 ? cells[expIdx] : null;
        if (dose && String(dose).trim()) filledRows++;
        const lotBad = lot && String(lot).trim();
        console.log(`   ${dose && String(dose).trim() ? "✅" : "·· "} ${label.slice(0, 52).padEnd(52)} dose=${JSON.stringify(dose ?? null)}${lotBad ? `  ❌LOT=${JSON.stringify(lot)}` : ""}${exp ? `  ❌EXP=${JSON.stringify(exp)}` : ""}`);
        if (lotBad || exp) allOk = false;
      });
    }
    const filledOk = expectFilled ? filledRows > 0 : true;
    if (leak.length) { console.log(`   ❌ LOT LEAK: ${leak.join(",")}`); allOk = false; }
    if (!filledOk) { console.log(`   ❌ expected at least one filled Standard Dose, got 0`); allOk = false; }
    console.log(`   → ${filledRows}/${totalRows} product rows carry a standard dose, lot-leak ${leak.length ? "❌" : "✅ none"}\n`);
  }

  console.log(allOk ? "✅ DRY VERIFY PASS — doses fill, no lot/exp leak." : "❌ DRY VERIFY FAIL — see above.");

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with IV_VERIFY_COMMIT=1 to post a Brain Boost draft to Alex Moran.");
    return;
  }
  if (!allOk) { console.log("\n⛔ refusing to COMMIT while dry verify is failing."); process.exit(1); }

  // ── Live post to Alex Moran (draft; left in place for visual review) ──
  // Match by name + EMAIL so we post to the correct chart even if the PB name has
  // a typo (email is the unique key). Override with PB_ALEX_MORAN_ID to be exact.
  const ALEX_EMAIL = process.env.PB_ALEX_MORAN_EMAIL || "alex@centnerhb.com";
  const found = process.env.PB_ALEX_MORAN_ID
    ? { id: process.env.PB_ALEX_MORAN_ID, firstName: "Alex", lastName: "Moran" }
    : await findPbPatient(pb, "Alex Moran", undefined, ALEX_EMAIL);
  if (!found?.id) throw new Error("could not resolve Alex Moran's PB client record (set PB_ALEX_MORAN_ID)");
  const displayName = `${found.firstName} ${found.lastName}`.trim();
  // Which protocol to post (default Brain Boost). e.g. IV_VERIFY_POST_HINT=Myers
  const wantHint = (process.env.IV_VERIFY_POST_HINT || "Brain Boost").toLowerCase();
  const bb = REFS.find((r) => r.hint.toLowerCase().includes(wantHint)) || REFS[0];
  const content = buildIvNoteContent(scaffoldFromNote(await getSessionNote(pb, bb.ref)), EMPTY_CHART);
  const title = ivNoteTitle({ serviceName: `IV - ${bb.hint}`, templateHint: bb.hint, kind: "standard" });
  const created = await createSessionNote(pb, {
    clientRecordId: found.id,
    name: `TEST – ${title} (Phase-1 dose-fill verify, safe to delete)`,
    summary: "IV-charting Phase-1 dose-fill verification — Brain Boost, no staff components",
    sessionDate: new Date().toISOString(),
    content,
  });
  console.log(`\n✓ POSTED draft to ${displayName} (${found.id}) — note id=${created.id}`);
  console.log("   Open it in PB and confirm the Standard Dose column shows ALA 300mg (12ml), Taurine, B12, Amino Acid.");
  console.log("   (Left in place for your review — say the word and I'll delete it.)");
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
