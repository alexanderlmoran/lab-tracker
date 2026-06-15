// Full IV-pipeline smoke test — asserts every piece of the 2026-06-15 fix set
// against the REAL logic + live DB + live PB. Read-only (no writes/posts).
// Run: cd worker && npx tsx scripts/iv-smoke-test.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { classifyIvService } from "../src/zenoti/iv-mapping.js";
import { buildIvNoteContent, extractTemplateComponents } from "../src/iv/build-note-content.js";
import { pickBestMatch } from "../src/iv/match-patient.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { listSessionNotes } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };
async function rest(path: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  return JSON.parse(await res.body.text());
}

// fake scaffold helpers
const compMatrix = (title: string, rows: any[]) => ({
  id: "q-" + title, object: "matrix",
  question: { object: "matrix", title, columns: [{ label: "Components" }, { label: "Standard Dose" }, { label: "Lot #" }], rows },
});
const row = (label: string, dose: string) => ({ label, cells: [{}, { label: dose }, {}] });

async function main() {
  // 1 ─ PC classification
  console.log("\n══ 1. PC / service classification ══");
  ok('"IV - PC" → kind=pc, not add-on', (() => { const i = classifyIvService("IV - PC"); return i?.kind === "pc" && !i.isAddOn; })());
  ok('"IV - PC20" → add-on, hint=Phosphatidylcholine Infusion', (() => { const i = classifyIvService("IV - PC20"); return i?.isAddOn === true && i.kind === "addon" && i.templateHint === "Phosphatidylcholine Infusion"; })());
  ok('"IV - PC15 SP" → add-on', classifyIvService("IV - PC15 SP")?.isAddOn === true);
  ok('"IV - Custom" → kind=custom', classifyIvService("IV - Custom")?.kind === "custom");
  ok('"IV - Curcumin 100mg" → kind=standard (un-templated)', classifyIvService("IV - Curcumin 100mg")?.kind === "standard");
  ok('"IV - PCA" does NOT misclassify as PC', classifyIvService("IV - PCA")?.kind !== "pc");

  // 2 ─ extractTemplateComponents single vs multi
  console.log("\n══ 2. Template-component extraction (prefill source) ══");
  const single = [compMatrix("Intravenous (IV) NS 0.9% - 500ml", [row("Vitamin C 500mg/ml", "10,000mg")])];
  const multi = [compMatrix("IV 500ml", [row("Vitamin C 500mg/ml", "10,000mg")]), compMatrix("IV Push", [row("Glutathione 200mg/ml", "500mg")])];
  ok("single-matrix template → extracts its rows", extractTemplateComponents(single as any).length === 1);
  ok("multi-matrix template → extracts [] (no unsafe prefill)", extractTemplateComponents(multi as any).length === 0);

  // 3 ─ base-IV fallback suppression (the cocktail bug)
  console.log("\n══ 3. base-IV fallback: no cocktail dump ══");
  const baseScaffold = [compMatrix("Intravenous (IV) NS 0.9% - 500ml", [row("Vitamin C 500mg/ml", "10,000mg")])] as any;
  const matched = JSON.stringify(buildIvNoteContent(baseScaffold, { preVitals: { bp: "120/80" } }, { baseFallback: false }));
  const fallback = JSON.stringify(buildIvNoteContent(baseScaffold, { preVitals: { bp: "120/80" } }, { baseFallback: true }));
  ok("matched template fills the catalog dose", matched.includes("10,000mg"));
  ok("base fallback (un-templated) leaves components BLANK", !fallback.includes("10,000mg"));

  // 4 ─ prefill cache in DB
  console.log("\n══ 4. iv_template_refs.components cache ══");
  const refs = (await rest("iv_template_refs?select=template_hint,components")) as any[];
  const byHint = (h: string) => refs.find((r) => r.template_hint === h)?.components ?? [];
  ok("PC cached with 7 components", byHint("Phosphatidylcholine Infusion").length === 7, `${byHint("Phosphatidylcholine Infusion").length}`);
  ok("__base_iv__ cached EMPTY (multi-section, no prefill)", byHint("__base_iv__").length === 0);
  ok("Immune Boost cached EMPTY (multi-section)", byHint("Immune Boost").length === 0);

  // 5 ─ patient matcher
  console.log("\n══ 5. Patient matcher (auto-post gate) ══");
  const idA = { fullName: "Test Person", email: "a@b.com" } as any;
  ok("name+email → auto-postable (95)", (() => { const b = pickBestMatch(idA, [{ id: "1", fullName: "Test Person", emailAddress: "a@b.com" }] as any); return !!b?.autoPostable && b.score >= 95; })());
  ok("name only → HOLDS (no unique id)", (() => { const b = pickBestMatch({ fullName: "Test Person" } as any, [{ id: "1", fullName: "Test Person" }] as any); return b ? !b.autoPostable : true; })());
  ok("email conflict → hard conflict, HOLDS", (() => { const b = pickBestMatch(idA, [{ id: "1", fullName: "Test Person", emailAddress: "x@y.com" }] as any); return !!b && b.hardConflict && !b.autoPostable; })());

  // 6 ─ duplicate guard (live PB)
  console.log("\n══ 6. Duplicate guard (live PB) ══");
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const findDup = async (client: string, date: string, hint: string) => {
    const notes = await listSessionNotes(pb, client, 30);
    const norm = (x?: string) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const keys = [norm(hint)].filter((k) => k.length >= 4);
    return notes.find((n: any) => String(n.sessionDate ?? "").slice(0, 10) === date && keys.some((k) => norm(n.name).includes(k) || k.includes(norm(n.name))))?.name ?? null;
  };
  const jennyDup = await findDup("69f8dabcf160a6e2ab2b0143", "2026-06-12", "Phosphatidylcholine Infusion");
  ok("Jenny 2026-06-12 PC → guard FINDS existing note (would hold)", !!jennyDup, jennyDup ? `"${jennyDup}"` : "none");
  const noDup = await findDup("69f8dabcf160a6e2ab2b0143", "2099-01-01", "Phosphatidylcholine Infusion");
  ok("bogus future date → guard finds nothing (would post)", noDup === null);

  // 7 ─ cleanup state
  console.log("\n══ 7. Bad-note cleanup state ══");
  const sessIds = ["25804f79-9d1e-41e2-99d3-b257d50ad7e1", "f6739783-776e-4aac-8be5-8f51224f352e", "936db585-6479-4cbb-904b-4b4373dd5a89", "0ef13038-8c8d-4ec6-b6c6-595291da2115"];
  const cleaned = (await rest(`iv_sessions?id=in.(${sessIds.join(",")})&select=patient_full_name,charting_status,pb_note_id`)) as any[];
  ok("all 4 bad-note sessions have pb_note_id cleared", cleaned.every((s) => s.pb_note_id === null), `${cleaned.filter((s) => s.pb_note_id === null).length}/4`);

  // 8 ─ Leila live state
  console.log("\n══ 8. Leila live state ══");
  const leila = (await rest("iv_sessions?patient_full_name=ilike.*leila*&select=service_name,kind,template_hint")) as any[];
  ok("Leila IV - PC → kind=pc, hint=Phosphatidylcholine Infusion", leila.some((s) => s.service_name === "IV - PC" && s.kind === "pc" && s.template_hint === "Phosphatidylcholine Infusion"));

  console.log(`\n══════ SMOKE TEST: ${pass} passed, ${fail} failed ══════`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
