// Read-only: dump the RAW question.rows vs answer for the IV Fluids + IM
// sections of the reference note, to settle whether lot numbers live in the
// question def (carried over by scaffoldFromNote) or only in the answer.
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const REF_NOTE = process.env.IV_VERIFY_REF_NOTE || "6a272b54271793958adbbdc2";

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const note = await getSessionNote(pb, REF_NOTE);
  for (const c of note.content ?? []) {
    const q = c.question as any;
    if (!/iv fluids|im medication/i.test(q.title ?? "")) continue;
    console.log(`\n■ "${q.title}"`);
    console.log(`  question.rows[].cells = ${JSON.stringify((q.rows ?? []).map((r: any) => r.cells))}`);
    console.log(`  answer = ${JSON.stringify((c as any).answer)}`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
