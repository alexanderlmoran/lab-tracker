// Throwaway: inspect the shape of listSessionNotes output so the dup-guard's
// date-field assumption (sessionDate/date) is correct.
// Run: cd worker && npx tsx scripts/iv-check-notelist.ts <clientRecordId>
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { listSessionNotes } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
async function main() {
  const client = process.argv[2];
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const notes = await listSessionNotes(pb, client, 30);
  console.log("count:", notes.length);
  console.log("keys[0]:", Object.keys((notes[0] ?? {}) as object).join(", "));
  for (const n of notes.slice(0, 14)) {
    const m = n as Record<string, unknown>;
    console.log(`  name="${n.name}"  sessionDate=${m.sessionDate ?? "—"}  date=${m.date ?? "—"}  created=${m.created ?? "—"}  modified=${m.dateModified ?? "—"}`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
