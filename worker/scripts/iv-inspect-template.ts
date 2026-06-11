// Read-only: dump the question STRUCTURE (object, columns, rows) of every item
// in the IV reference note, so we can complete buildIvNoteContent's mapping for
// components / attempts / reaction / removal. Template text only — not PHI.
//
// Run: cd worker && npx tsx scripts/iv-inspect-template.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;
const REF_NOTE = process.env.IV_VERIFY_REF_NOTE || "6a272b54271793958adbbdc2";

async function main() {
  const pb = await pbLogin(U, P);
  const note = await getSessionNote(pb, REF_NOTE);
  for (const c of note.content ?? []) {
    const q = c.question as any;
    console.log(`\n■ ${q.object}  "${q.title ?? ""}"`);
    const cols = (q.columns ?? []).map((col: any) => `${col.label ?? "·"}${col.columnType ? `[${col.columnType}]` : ""}`);
    if (cols.length) console.log(`   columns: ${cols.join(" | ")}`);
    for (const r of q.rows ?? []) {
      const cells = (r.cells ?? []).map((cell: any) => JSON.stringify(cell)).join(", ");
      console.log(`   row: "${r.label ?? ""}"${r.isHeader ? " (header)" : ""}${cells ? `  cells=[${cells}]` : ""}`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
