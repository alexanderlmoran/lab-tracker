// CHRONIC missing-dose audit. For EVERY seeded iv_template_refs row, build the
// note the worker would auto-post WITH NO STAFF COMPONENTS (the blank-dose path:
// catalogComponentsAnswer), and report per component row whether the Standard
// Dose fills — and from where: TEMPLATE cell, CATALOG, or BLANK (the gap).
//
// Read-only. Run: cd worker && npx tsx scripts/iv-audit-dose-coverage.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote } from "../src/uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, type IvChartInput } from "../src/iv/build-note-content.js";
import { standardDoseFor } from "../src/iv/component-doses.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
const EMPTY: IvChartInput = { preVitals: { bp: "118/76" } }; // no components → catalog path
const lc = (s?: string) => (s ?? "").toLowerCase();

async function rest(path: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  return JSON.parse(await res.body.text());
}

function isDoseMatrix(q: any): boolean {
  if (!q || q.object !== "matrix") return false;
  const t = lc(q.title);
  if (/vital|attempt|location|reaction|removal|shot given|initial assess/.test(t)) return false;
  return (q.columns ?? []).some((c: any) => /dose/i.test(c.label ?? ""));
}

async function main() {
  const refs = (await rest("iv_template_refs?select=template_hint,reference_note_id,note")) as Array<{ template_hint: string; reference_note_id: string; note?: string }>;
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  console.log(`\n══ dose coverage across ${refs.length} seeded templates (empty-chart auto-post path) ══`);

  const gapLines: string[] = [];
  for (const r of refs.sort((a, b) => a.template_hint.localeCompare(b.template_hint))) {
    let ref;
    try { ref = await getSessionNote(pb, r.reference_note_id); } catch (e) { console.log(`\n❌ ${r.template_hint}: ${e instanceof Error ? e.message : e}`); continue; }
    const content = buildIvNoteContent(scaffoldFromNote(ref), EMPTY) as any[];
    let filled = 0, blank = 0;
    const blanks: string[] = [];
    const lines: string[] = [];
    for (const item of content) {
      const q = item.question;
      if (!isDoseMatrix(q)) continue;
      const cols = (q.columns ?? []).map((c: any) => lc(c.label));
      const stdIdx = cols.findIndex((l: string) => /standard dose/.test(l) || /^dose$/.test(l));
      const ans = new Map<number, any[]>((item.answer?.answers ?? []).map((a: any) => [a.index, a.cells ?? []]));
      (q.rows ?? []).forEach((row: any, i: number) => {
        const label = row.label ?? "";
        if (!label || /^\[enter/i.test(label)) return;
        const aCell = stdIdx >= 0 ? ans.get(i)?.[stdIdx] : null;
        const tplCell = stdIdx >= 0 ? row.cells?.[stdIdx]?.label : undefined; // preserved template dose
        const cat = standardDoseFor(label);
        const dose = aCell && String(aCell).trim() ? String(aCell) : "";
        const src = dose ? (tplCell && String(tplCell).trim() ? "TEMPLATE" : cat ? "CATALOG" : "?") : "BLANK";
        if (dose) filled++; else { blank++; blanks.push(label); }
        lines.push(`     ${dose ? "✅" : "❌"} ${label.slice(0, 44).padEnd(44)} ${dose ? `${JSON.stringify(dose)} [${src}]` : "— blank —"}`);
      });
    }
    const tag = blank === 0 ? "✅" : "⚠️";
    console.log(`\n${tag} ${r.template_hint}  (${filled} filled / ${blank} blank)  ref=${r.reference_note_id}`);
    lines.forEach((l) => console.log(l));
    if (blank > 0) gapLines.push(`  ${r.template_hint}: ${blanks.join(", ")}`);
  }

  console.log(`\n══ GAP SUMMARY — components posting BLANK (need a dose: in PB template or catalog) ══`);
  if (!gapLines.length) console.log("  ✅ every template fills every component");
  else gapLines.forEach((l) => console.log(l));
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
