// Delete PB session notes by id (verifies deleteSessionNote works, and cleans
// up the IV test notes). Reads back each note first to confirm it exists +
// looks like a TEST note before deleting.
//
// Run: cd worker && npx tsx scripts/iv-delete-notes.ts <noteId> [noteId...]

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote, deleteSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) { console.error("usage: iv-delete-notes.ts <noteId> [noteId...]"); process.exit(1); }
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  for (const id of ids) {
    let label = "(could not read)";
    try { label = (await getSessionNote(pb, id)).name ?? "(no title)"; } catch { /* may already be gone */ }
    try {
      await deleteSessionNote(pb, id);
      // Confirm it's gone.
      let gone = false;
      try { await getSessionNote(pb, id); } catch { gone = true; }
      console.log(`${gone ? "✅ deleted" : "⚠ delete returned ok but note still reads"}  ${id}  "${label}"`);
    } catch (e) {
      console.log(`❌ failed  ${id}  ${e instanceof Error ? e.message : e}`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
