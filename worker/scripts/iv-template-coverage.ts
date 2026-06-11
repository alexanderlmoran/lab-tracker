// Read-only coverage check: does EVERY IV type post correctly?
//  1. For each iv_template_refs row → getSessionNote(ref) → scaffoldFromNote →
//     buildIvNoteContent(sample) and report which sections map (proves the
//     template posts a complete note).
//  2. List distinct (template_hint, kind) seen in iv_sessions that have NO
//     template ref → those would HOLD "no reference scaffold" (coverage gaps).
//
// Run: cd worker && npx tsx scripts/iv-template-coverage.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote } from "../src/uploaders/pb-sessionnotes.js";
import { buildIvNoteContent, type IvChartInput } from "../src/iv/build-note-content.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;

const SAMPLE: IvChartInput = {
  assessment: { initialCheckIn: true, risksDiscussed: true, consentSigned: true, intakeSigned: true, historyDiscussed: true },
  preVitals: { bp: "118/76", spo2: "98", temp: "98.4", hr: "68", resp: "14" },
  postVitals: { bp: "121/79", spo2: "99", temp: "98.7", hr: "71", resp: "16" },
  ivStart: { cath: "22" }, attempts: "1", location: "right_antecubital", infusionFlowingWell: true,
  components: [{ name: "Vitamin C", standardDose: "500mg/ml" }],
  infusionReaction: { occurred: false }, ivRemoval: true,
};

async function rest(path: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  return JSON.parse(await res.body.text());
}

const has = (items: any[], re: RegExp) => items.some((c) => re.test((c.question?.title ?? "").toLowerCase()) && c.answer !== undefined);
// Mirror /api/worker/iv-post/next's normalized template_hint matching.
const normHint = (s: string | null | undefined) => (s ?? "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').toLowerCase().replace(/\s+/g, " ").trim();

async function main() {
  const refs = (await rest("iv_template_refs?select=template_hint,reference_note_id")) as Array<{ template_hint: string; reference_note_id: string }>;
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  console.log(`\n══ ${refs.length} seeded template(s) ══`);
  let ok = 0;
  for (const r of refs.sort((a, b) => a.template_hint.localeCompare(b.template_hint))) {
    try {
      const ref = await getSessionNote(pb, r.reference_note_id);
      const content = buildIvNoteContent(scaffoldFromNote(ref), SAMPLE);
      const answered = content.filter((c) => c.answer !== undefined).length;
      const flags = [
        has(content, /initial assessment/) ? "A" : "·",
        has(content, /pre.?infusion vitals/) ? "V" : "·",
        has(content, /iv start/) ? "S" : "·",
        has(content, /attempt|location/) ? "T" : "·",
        has(content, /fluid/) ? "C" : "·",
        has(content, /reaction/) ? "R" : "·",
        has(content, /removal/) ? "X" : "·",
      ].join("");
      console.log(`  ✅ ${r.template_hint.padEnd(34)} ${content.length} items, ${answered} answered  [${flags}]`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${r.template_hint.padEnd(34)} ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`  (sections: A=assessment V=vitals S=ivstart T=attempts/loc C=components R=reaction X=removal)`);
  console.log(`  → ${ok}/${refs.length} templates build a complete note`);

  // Coverage gaps: template_hints in iv_sessions with no ref.
  const sessions = (await rest("iv_sessions?select=template_hint,kind,service_name&limit=2000")) as Array<{ template_hint: string | null; kind: string; service_name: string }>;
  const refSet = new Set(refs.map((r) => normHint(r.template_hint)));
  const gaps = new Map<string, { kind: string; n: number; example: string }>();
  for (const s of sessions) {
    const hint = s.template_hint ?? "";
    if (s.kind === "ebo") continue; // EBOO/EBO2 are intentionally manual
    if (refSet.has(normHint(hint))) continue;
    const g = gaps.get(hint) ?? { kind: s.kind, n: 0, example: s.service_name };
    g.n++; gaps.set(hint, g);
  }
  console.log(`\n══ coverage gaps (synced sessions with no template ref; EBOO/EBO2 excluded) ══`);
  if (gaps.size === 0) console.log("  ✅ none — every non-EBO synced session has a template");
  else for (const [hint, g] of [...gaps.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ⚠ ${(hint || "(blank)").padEnd(34)} kind=${g.kind} ×${g.n}  e.g. "${g.example}"`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
