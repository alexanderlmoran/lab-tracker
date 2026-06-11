// Decode the `yesno` matrix cell encoding (read-only). Shows booleans + short
// codes (the encoding) but redacts any free-text (PHI). Completes the answer-
// encoding map so the poster can fill Reaction / IV Removal / Attempts etc.
//
// Run:  cd worker && npx tsx scripts/pb-yesno-shape.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;
const NOTE = "6a272b54271793958adbbdc2";

// Reveal encoding (booleans, short codes) but redact long strings (free-text PHI).
function enc(v: any, d: number): any {
  if (Array.isArray(v)) return d <= 0 ? `[arr${v.length}]` : v.slice(0, 4).map((x) => enc(x, d - 1));
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = enc(v[k], d - 1); return o; }
  if (typeof v === "string") return v.length <= 12 ? v : `<str:${v.length}>`;
  return v; // numbers + booleans shown (encoding, not PHI)
}

async function main() {
  const s = await pbLogin(U, P);
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${NOTE}`, { method: "GET", headers: { ...pbApiHeaders(s), "x-api-version": "5.1", accept: "application/json, text/plain, */*" } });
  const j: any = JSON.parse(await res.body.text());
  for (const item of j.content || []) {
    const q = item.question || {};
    const colTypes = (q.columns || []).map((c: any) => c.columnType || c.label);
    if (!colTypes.includes("yesno")) continue;
    console.log(`▸ ${q.object} "${q.title}"  cols=${JSON.stringify(colTypes)}`);
    console.log(`   answer[0] enc: ${JSON.stringify(enc((item.answer?.answers || [])[0], 6))}`);
    console.log("");
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
