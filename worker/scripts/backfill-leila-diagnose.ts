// Diagnostic: does Leila have multiple PB patient records? List every
// "leila centner"-ish match and the labrequest count on each chart.
// Run this if backfill-leila-preview reports 0 PB labrequests despite
// the team having uploaded labs historically.
//
//   cd worker
//   npx tsx scripts/backfill-leila-diagnose.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import {
  pbLogin,
  listPatientLabRequests,
  type PbSession,
} from "../src/uploaders/practicebetter.js";

loadEnvLocal();

const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;
if (!PB_USERNAME || !PB_PASSWORD) {
  throw new Error("PB_USERNAME / PB_PASSWORD required");
}

const PB_BASE = "https://my.practicebetter.io";

type SearchItem = {
  id: string;
  profile: {
    firstName: string;
    lastName: string;
    dayOfBirth?: string;
    emailAddress?: string;
  };
};

function pbApiHeaders(s: PbSession): Record<string, string> {
  return {
    cookie: s.cookies,
    "x-xsrf-token": s.csrfToken,
    "x-company-id": s.companyId,
    "x-session-id": s.sessionId,
    "x-platform": "web",
    "x-timezone": "America/New_York,en-us",
  };
}

async function searchAllVariations(session: PbSession): Promise<SearchItem[]> {
  // Try multiple search queries to surface ALL plausible Leila records,
  // not just the one DOB happens to match.
  const queries = ["leila centner", "leila", "centner"];
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  for (const q of queries) {
    const url = `${PB_BASE}/api/consultant/records/search?countlimit=25&limit=25&query=${encodeURIComponent(q).replace(/%20/g, "+")}`;
    const res = await request(url, { method: "GET", headers: pbApiHeaders(session) });
    if (res.statusCode !== 200) {
      console.error(`  search '${q}' returned ${res.statusCode}`);
      continue;
    }
    const json = (await res.body.json()) as { items?: SearchItem[] };
    for (const it of json.items ?? []) {
      const ln = (it.profile.lastName ?? "").toLowerCase();
      const fn = (it.profile.firstName ?? "").toLowerCase();
      if (!ln.includes("centner") && !fn.includes("leila")) continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
  }
  return merged;
}

async function main() {
  console.log("─".repeat(70));
  console.log("PB DIAGNOSTIC — surface all Leila records and labrequest counts");
  console.log("─".repeat(70));

  const session = await pbLogin(PB_USERNAME!, PB_PASSWORD!);
  console.log(`✓ PB login OK (user=${session.userId}, company=${session.companyId})`);

  const matches = await searchAllVariations(session);
  console.log(`\nFound ${matches.length} matching record(s):\n`);

  for (const m of matches) {
    console.log(`─ pb_patient_id: ${m.id}`);
    console.log(`  firstName:    ${m.profile.firstName}`);
    console.log(`  lastName:     ${m.profile.lastName}`);
    console.log(`  dayOfBirth:   ${m.profile.dayOfBirth ?? "(none)"}`);
    console.log(`  email:        ${m.profile.emailAddress ?? "(none)"}`);
    try {
      const labs = await listPatientLabRequests(session, m.id, { limit: 200 });
      console.log(`  labrequests:  ${labs.length}`);
      if (labs.length > 0) {
        for (const lr of labs.slice(0, 3)) {
          console.log(
            `    • ${lr.id}  "${lr.name}"  ordered=${(lr.dateOrdered ?? "").slice(0, 10)}`,
          );
        }
        if (labs.length > 3) console.log(`    … and ${labs.length - 3} more`);
      }
    } catch (err) {
      console.log(`  labrequests:  ERROR ${err instanceof Error ? err.message : err}`);
    }
    console.log("");
  }

  if (matches.length === 0) {
    console.log("No records found. Either Leila isn't on PB, or the search auth");
    console.log("is scoped to a different consultant than this account.");
  }

  // ── Bigger diagnostic: hit the labrequests endpoint with NO filter ──
  // If the team has uploaded labs at all, something must show up here.
  console.log("─".repeat(70));
  console.log("Pulling labrequests with NO records filter (consultant-wide)…");
  console.log("─".repeat(70));
  const unfiltered = await request(
    `${PB_BASE}/api/consultant/labrequests?limit=10&sort=orderdate_desc`,
    { method: "GET", headers: pbApiHeaders(session) },
  );
  console.log(`HTTP ${unfiltered.statusCode}`);
  const bodyText = await unfiltered.body.text();
  const preview = bodyText.length > 1500 ? bodyText.slice(0, 1500) + "…" : bodyText;
  console.log(preview);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
