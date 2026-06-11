// Reveal the ANSWER encoding per question type from a reference note, as TYPES
// ONLY (every leaf value → its typeof), so zero PHI is printed. Tells us exactly
// what to put in answer.* when filling a note programmatically.
//
// Run:  cd worker && npx tsx scripts/pb-answer-shape.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;
const NOTE = "6a272b54271793958adbbdc2"; // Leila's PC infusion note (filled)

function typeShape(v: any, d: number): any {
  if (Array.isArray(v)) {
    if (d <= 0) return `[arr${v.length}]`;
    const head = v.slice(0, 2).map((x) => typeShape(x, d - 1));
    if (v.length > 2) head.push(`…x${v.length}`);
    return head;
  }
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = typeShape(v[k], d - 1);
    return o;
  }
  return typeof v;
}

async function main() {
  const s = await pbLogin(U, P);
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${NOTE}`, {
    method: "GET",
    headers: { ...pbApiHeaders(s), "x-api-version": "5.1", accept: "application/json, text/plain, */*" },
  });
  const j: any = JSON.parse(await res.body.text());
  console.log(`note status ${res.statusCode}, content items: ${(j.content || []).length}\n`);
  for (const item of j.content || []) {
    const q = item.question || {};
    const rowLabels = (q.rows || []).map((r: any) => (typeof r.label === "string" ? r.label.slice(0, 30) : "?"));
    const colTypes = (q.columns || []).map((c: any) => c.columnType || c.label || "?");
    console.log(`▸ ${q.object}  ·  "${q.title || ""}"  (itemObject=${item.object})`);
    console.log(`   rows: ${JSON.stringify(rowLabels)}`);
    console.log(`   cols: ${JSON.stringify(colTypes)}`);
    console.log(`   ANSWER shape: ${JSON.stringify(typeShape(item.answer, 5))}`);
    console.log("");
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
