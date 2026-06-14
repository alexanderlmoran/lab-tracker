// Diagnose a posted IV note: for every dose-bearing matrix, print BOTH the
// QUESTION row cell and the ANSWER cell at the Standard-Dose column, so we can
// see whether a missing dose is (a) absent from the posted content, or (b) present
// but not where PB renders it. Read-only.
//
// Run: cd worker && npx tsx scripts/iv-diagnose-note.ts <noteId> [noteId2 …]

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;
const IDS = process.argv.slice(2).filter(Boolean);
if (!IDS.length) throw new Error("pass at least one note id");
const lc = (s?: string) => (s ?? "").toLowerCase();

async function main() {
  const pb = await pbLogin(U, P);
  for (const id of IDS) {
    let note;
    try { note = await getSessionNote(pb, id); } catch (e) { console.log(`\n■ ${id}: FETCH FAILED ${e instanceof Error ? e.message : e}`); continue; }
    console.log(`\n■ NOTE ${id}  name=${JSON.stringify((note as any).name)}  publishStatus=${(note as any).publishStatus}`);
    for (const c of (note.content ?? []) as any[]) {
      const q = c.question;
      if (!q || q.object !== "matrix") continue;
      const cols = (q.columns ?? []).map((x: any) => x.label ?? "·");
      const types = (q.columns ?? []).map((x: any) => x.columnType ?? "");
      const hasDose = cols.some((l: string) => /dose/i.test(l));
      if (!hasDose) continue;
      const stdIdx = cols.findIndex((l: string) => /standard dose/i.test(l) || /^dose$/i.test(l));
      console.log(`\n  ▸ "${q.title}"  cols=[${cols.map((l: string, i: number) => `${l}{${types[i]}}`).join(" | ")}]  stdIdx=${stdIdx}`);
      const ansByRow = new Map<number, any[]>((c.answer?.answers ?? []).map((a: any) => [a.index, a.cells ?? []]));
      (q.rows ?? []).forEach((r: any, i: number) => {
        const label = r.label ?? "";
        if (!label) return;
        const qCell = stdIdx >= 0 ? r.cells?.[stdIdx] : undefined;
        const aCells = ansByRow.get(i);
        const aCell = stdIdx >= 0 && aCells ? aCells[stdIdx] : undefined;
        console.log(`     row "${label.slice(0, 46)}"`);
        console.log(`        QUESTION cell[std] = ${JSON.stringify(qCell ?? null)}`);
        console.log(`        ANSWER   cell[std] = ${JSON.stringify(aCell ?? null)}  (answerRowPresent=${ansByRow.has(i)})`);
      });
    }
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
