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

import { materializePortalSessions } from "../src/lib/portal-sessions.js";
import { fetchZenotiApptRows } from "../src/zenoti/fetch-browser.js";
import { resolveLabName } from "../src/zenoti/lab-mapping.js";

async function main() {
  materializePortalSessions(); // decodes ZENOTI_SESSION_B64 → sets ZENOTI_STORAGE_PATH

  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("usage: zenoti-debug-day.ts YYYY-MM-DD");
    process.exit(1);
  }
  const storagePath = process.env.ZENOTI_STORAGE_PATH;
  if (!storagePath) {
    console.error(
      "ZENOTI_STORAGE_PATH not set. On Fly it's decoded from ZENOTI_SESSION_B64 at boot " +
        "(run inside `fly ssh console` so the secret is present). Locally, point it at a fresh capture.",
    );
    process.exit(1);
  }

  const rows = await fetchZenotiApptRows({ storagePath, date, includeCancelled: true });
  console.log(`\nZenoti setDate ${date} — ${rows.length} raw appointment row(s) at the synced center:\n`);
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
