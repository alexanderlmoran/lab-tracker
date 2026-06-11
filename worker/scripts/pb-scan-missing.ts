// Surface candidate notes for the IV templates NOT yet in iv_template_refs —
// searching ALL note names (not just "IV -" prefixed), so EBOO/EBO2/Custom/etc.
// show up. Read-only; prints distinct matching note names + ids for human pick.
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;

// [label, regex over note name] for the missing/ambiguous templates.
const PROBES: Array<[string, RegExp]> = [
  ["EBOO", /ebo{2,}|oxygenation|ozone/i],
  ["EBO2", /ebo2/i],
  ["Custom (pure)", /\bcustom\b/i],
  ["NR+ 250", /\bnr\b.*250|250.*\bnr\b/i],
  ["NR+ 500", /\bnr\b.*500|500.*\bnr\b/i],
  ["Weber (pure)", /weber/i],
  ["Methylene Blue", /methylene/i],
  ["Signature Cocktail", /signature/i],
  ["Curcumin", /curcumin/i],
  ["EDTA", /edta/i],
  ["Chelation", /chelat/i],
  ["Luma Elite UVBI", /luma/i],
  ["Regenesis", /regenesis/i],
  ["Beauty Boost (pure)", /beauty boost/i],
];

async function main() {
  const s = await pbLogin(U, P);
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes?limit=2000&sort=date_desc`, { method: "GET", headers: { ...pbApiHeaders(s), "x-api-version": "5.1", accept: "application/json, text/plain, */*" } });
  const j = (await res.body.json()) as { items?: Array<{ id: string; name?: string }> };
  const items = j.items ?? [];
  const byName = new Map<string, string>();
  for (const n of items) if (n.name && !byName.has(n.name)) byName.set(n.name, n.id);
  console.log(`${byName.size} distinct note names in last ${items.length}\n`);
  for (const [label, re] of PROBES) {
    const hits = [...byName.entries()].filter(([name]) => re.test(name)).slice(0, 5);
    console.log(`▸ ${label}: ${hits.length === 0 ? "— none found —" : ""}`);
    for (const [name, id] of hits) console.log(`    ${id}  "${name}"`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
