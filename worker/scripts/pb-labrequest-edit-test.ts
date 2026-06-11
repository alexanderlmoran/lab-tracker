// Edit an EXISTING PB labrequest (title / dateOrdered). The create path is
// proven (uploader); this mirrors PB's update convention from the IV
// session-note work: writes need `x-api-version` + content-type on top of
// pbApiHeaders — a bare PUT without them is rejected.
//
// Usage (from worker/):
//   npx tsx scripts/pb-labrequest-edit-test.ts --id <labrequestId>
//       → GET the labrequest, print key fields (discovery, read-only)
//   npx tsx scripts/pb-labrequest-edit-test.ts --id <id> [--name "New title"] \
//       [--date YYYY-MM-DD] --apply
//       → write the change (minimal body PUT → POST-to-id → full-echo PUT),
//         then re-GET to verify.
//
// Dates are sent as noon UTC so PB's Eastern rendering can't shift them a
// day (same fix as pb-upload-worker dateOrdered).

import { loadEnvLocal } from "../src/lib/load-env.js";
loadEnvLocal();

import {
  PB_BASE,
  pbApiHeaders,
  pbLogin,
  pbRequest,
  type PbSession,
} from "../src/uploaders/practicebetter.js";

// NOTE: unlike sessionnotes (which require x-api-version 5.1), the
// labrequests surface REJECTS the header with 425 UnsupportedApiVersion —
// plain pbApiHeaders is the convention here (same as createLabRequest).
function writeHeaders(session: PbSession): Record<string, string> {
  return {
    ...pbApiHeaders(session),
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
  };
}

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = arg("id");
const apply = process.argv.includes("--apply");
const newName = arg("name");
const newDate = arg("date");

if (!id) {
  console.error("usage: pb-labrequest-edit-test.ts --id <labrequestId> [--name ...] [--date YYYY-MM-DD] [--apply]");
  process.exit(1);
}

async function main() {
  const session = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const detailUrl = `${PB_BASE}/api/consultant/labrequests/${id}`;
  const get = async () => {
    const res = await pbRequest(detailUrl, { headers: pbApiHeaders(session) });
    const text = await res.body.text();
    return { status: res.statusCode, obj: res.statusCode === 200 ? (JSON.parse(text) as Record<string, unknown>) : null, text };
  };

  const before = await get();
  if (!before.obj) {
    console.error(`GET ${detailUrl} → ${before.status}: ${before.text.slice(0, 300)}`);
    process.exit(1);
  }
  const brief = (o: Record<string, unknown>) =>
    JSON.stringify({ name: o.name, dateOrdered: o.dateOrdered, requestStatus: o.requestStatus, dateModified: o.dateModified });
  console.log("BEFORE:", brief(before.obj));
  if (!apply) {
    console.log("(discovery only — re-run with --apply to write)");
    return;
  }

  // Minimal create-shaped body (NOT the full echo: the GET embeds heavy
  // read-only consultant/clientRecord blobs). notify stays false — an edit
  // must never re-send the patient-portal invitation.
  const o = before.obj;
  const minimal: Record<string, unknown> = {
    id,
    object: "labrequest",
    clientRecordId: (o.clientRecord as { id?: string } | null)?.id,
    publishStatus: o.publishStatus,
    requestStatus: o.requestStatus,
    dateOrdered: newDate ? `${newDate}T12:00:00.000Z` : o.dateOrdered,
    name: newName ?? o.name,
    artifacts: o.artifacts ?? [],
    includeFhr: false,
    isClientFacing: false,
    notify: false,
    asConsultantId: process.env.PB_CONSULTANT_ID,
  };
  const fullEcho = { ...o, name: minimal.name, dateOrdered: minimal.dateOrdered, notify: false };

  const attempts: Array<{ label: string; method: "PUT" | "POST"; url: string; body: unknown }> = [
    { label: "minimal PUT /labrequests/{id}", method: "PUT", url: detailUrl, body: minimal },
    { label: "minimal POST /labrequests/{id}", method: "POST", url: detailUrl, body: minimal },
    { label: "full-echo PUT /labrequests/{id}", method: "PUT", url: detailUrl, body: fullEcho },
  ];

  let saved = false;
  for (const a of attempts) {
    const res = await pbRequest(a.url, {
      method: a.method,
      headers: writeHeaders(session),
      body: JSON.stringify(a.body),
    });
    const text = await res.body.text();
    console.log(`${a.label} → ${res.statusCode}: ${text.slice(0, 200)}`);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      saved = true;
      break;
    }
  }
  if (!saved) {
    console.error("no attempt accepted — next step is capturing the PB UI's own edit request.");
    process.exit(1);
  }

  const after = await get();
  console.log("AFTER: ", after.obj ? brief(after.obj) : after.text.slice(0, 200));
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
