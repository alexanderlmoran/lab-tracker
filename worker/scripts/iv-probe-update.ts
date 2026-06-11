// Probe: can we UPDATE an existing PB session note (so a re-post completes the
// same note instead of creating a duplicate)? Creates a throwaway note on Leila,
// tries PUT then PATCH with a changed value, reads back, then deletes it.
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbRequest, PB_BASE } from "../src/uploaders/practicebetter.js";
import { createSessionNote, getSessionNote, deleteSessionNote, pbNoteHeaders } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();
const LEILA = process.env.PB_TEST_PATIENT_ID || "641868664a3099220158325b";

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const created = await createSessionNote(pb, {
    clientRecordId: LEILA, name: "TEST – update probe (delete me)", summary: "v1",
    sessionDate: new Date().toISOString(), content: [],
  });
  console.log(`created ${created.id}`);

  const body = JSON.stringify({
    id: created.id, notesId: created.id, clientRecordId: LEILA, name: "TEST – update probe (delete me)",
    summary: "v2-UPDATED", sessionDate: new Date().toISOString(), publishStatus: "draft",
    content: [], object: "sessionnote",
  });
  for (const method of ["PUT"]) {
    const url = method === "POST"
      ? `${PB_BASE}/api/consultant/sessionnotes/${created.id}`
      : `${PB_BASE}/api/consultant/sessionnotes/${created.id}`;
    const res = await pbRequest(url, { method, headers: pbNoteHeaders(pb, true), body });
    const txt = (await res.body.text()).slice(0, 120);
    console.log(`${method} ${created.id} → ${res.statusCode}  ${txt.replace(/\s+/g, " ")}`);
    if (res.statusCode < 300) {
      const back = await getSessionNote(pb, created.id);
      console.log(`   readback summary = ${JSON.stringify((back as any).summary)}`);
      break;
    }
  }
  await deleteSessionNote(pb, created.id);
  console.log(`deleted ${created.id}`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
