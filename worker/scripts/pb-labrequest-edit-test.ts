// Discover + exercise EDITING an existing PB labrequest (title / dateOrdered).
// The create path is proven (uploader); this finds the update endpoint by
// mirroring PB's fetch-shape-then-save convention (same as the IV sessionnote
// fill work).
//
// Usage (from worker/):
//   npx tsx scripts/pb-labrequest-edit-test.ts --id <labrequestId>
//       → GET the labrequest, print its JSON shape (discovery, read-only)
//   npx tsx scripts/pb-labrequest-edit-test.ts --id <id> [--name "New title"] \
//       [--date 2026-05-18] --apply
//       → write the change (PUT first, POST fallback), then re-GET to verify.
//
// Dates pass as YYYY-MM-DD and are sent as noon UTC so PB's Eastern rendering
// can't shift them a day (same fix as pb-upload-worker dateOrdered).

import { loadEnvLocal } from "../src/lib/load-env.js";
loadEnvLocal();

import {
  PB_BASE,
  pbApiHeaders,
  pbLogin,
  pbRequest,
} from "../src/uploaders/practicebetter.js";

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
  console.log("logged in");

  const detailUrl = `${PB_BASE}/api/consultant/labrequests/${id}`;
  const get = async () => {
    const res = await pbRequest(detailUrl, { headers: pbApiHeaders(session) });
    const text = await res.body.text();
    return { status: res.statusCode, text };
  };

  const before = await get();
  console.log(`GET ${detailUrl} → ${before.status}`);
  console.log(before.text.slice(0, 4000));
  if (before.status !== 200) {
    console.error("detail GET failed — endpoint shape differs; stop here and capture from the PB UI instead.");
    process.exit(1);
  }
  if (!apply) {
    console.log("\n(discovery only — re-run with --apply to write)");
    return;
  }

  const obj = JSON.parse(before.text) as Record<string, unknown>;
  const updated: Record<string, unknown> = { ...obj };
  if (newName) updated.name = newName;
  if (newDate) updated.dateOrdered = `${newDate}T12:00:00.000Z`;

  let saved = false;
  for (const method of ["PUT", "POST"] as const) {
    const res = await pbRequest(detailUrl, {
      method,
      headers: { ...pbApiHeaders(session), "content-type": "application/json" },
      body: JSON.stringify(updated),
    });
    const text = await res.body.text();
    console.log(`${method} ${detailUrl} → ${res.statusCode}: ${text.slice(0, 300)}`);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      saved = true;
      break;
    }
  }
  if (!saved) {
    console.error("neither PUT nor POST accepted the update — capture the PB UI edit flow for the real endpoint.");
    process.exit(1);
  }

  const after = await get();
  const a = JSON.parse(after.text) as { name?: string; dateOrdered?: string };
  console.log(`\nverify → name="${a.name}" dateOrdered=${a.dateOrdered}`);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
