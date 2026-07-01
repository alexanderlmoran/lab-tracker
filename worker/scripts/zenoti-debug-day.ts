// Raw Zenoti setDate dump for one day — GROUND TRUTH for "why didn't appt X sync?".
//
// Prints EVERY appointment row the Zenoti book returns for the date (patient,
// service name, cancel/no-show status, start time) and how resolveLabName()
// classifies each. The point: if an appointment you can SEE in the Zenoti UI is
// MISSING from this dump, then Zenoti itself is not returning it to us
// (center scope / session permissions / appointment state) — it is NOT our
// filtering. If it IS listed but shows "dropped", the service name is the issue.
//
// Run ON the Fly machine (it holds the live session decoded from ZENOTI_SESSION_B64):
//   fly ssh console -a lab-tracker-worker
//   # then, from the app dir:
//   npx tsx scripts/zenoti-debug-day.ts 2026-07-01
// Or locally with a fresh capture:
//   ZENOTI_STORAGE_PATH=captures/zenoti/<ts>/storage.json npx tsx scripts/zenoti-debug-day.ts 2026-07-01

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializePortalSessions } from "../src/lib/portal-sessions.js";
import { fetchZenotiApptRows, CENTER_ID, ORG_ID } from "../src/zenoti/fetch-browser.js";
import { resolveLabName } from "../src/zenoti/lab-mapping.js";

async function main() {
  materializePortalSessions(); // decodes ZENOTI_SESSION_B64 → sets ZENOTI_STORAGE_PATH

  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("usage: zenoti-debug-day.ts YYYY-MM-DD");
    process.exit(1);
  }
  // The RUNNING worker on this machine already decoded the session to a temp file
  // at boot — even though a fresh `fly ssh console` shell doesn't inherit
  // ZENOTI_SESSION_B64, that file is on disk. Fall back to it so this "just works".
  let storagePath = process.env.ZENOTI_STORAGE_PATH;
  if (!storagePath) {
    const materialized = join(tmpdir(), "portal-sessions", "zenoti-storage.json");
    if (existsSync(materialized)) storagePath = materialized;
  }
  if (!storagePath) {
    console.error(
      "No Zenoti session found. Run on the ZENOTI machine (0804045b230d48) where the\n" +
        "worker materialized it, or set ZENOTI_STORAGE_PATH=/tmp/portal-sessions/zenoti-storage.json\n" +
        "(or point it at a fresh local capture).",
    );
    process.exit(1);
  }

  console.log(`\nQuerying Zenoti org=${ORG_ID}\n         center=${CENTER_ID}  (the ONE center this sync watches)`);
  const rows = await fetchZenotiApptRows({ storagePath, date, includeCancelled: true });
  console.log(`\nsetDate ${date} — ${rows.length} raw appointment row(s) at that center:\n`);
  for (const r of rows) {
    const svc = r.servicename ?? "(no service)";
    const lab = resolveLabName(svc);
    const who = (r.Name ?? `${r.FName ?? ""} ${r.LName ?? ""}`.trim()) || "(no name)";
    const flag = Number(r.cancelOrNoShowStatus ?? "0") !== 0 ? " [CANCELLED/NOSHOW]" : "";
    console.log(
      `  • ${who}  |  "${svc}"  →  ${lab ? `LAB=${lab} ✓card` : "dropped (not a lab service)"}${flag}  |  ${r.starttime ?? "?"}`,
    );
  }
  const labCount = rows.filter((r) => resolveLabName(r.servicename ?? "")).length;
  console.log(
    `\n${labCount} row(s) would become a tracker card.\n` +
      `If an appointment you can see in Zenoti is NOT in this list, Zenoti isn't returning it ` +
      `to the sync — check the appointment's center and its booked/confirmed state.\n`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
