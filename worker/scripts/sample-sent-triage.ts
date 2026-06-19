// Sample Sent triage — read-only. Prints why every "Sample Sent" case is / isn't
// being auto-pulled into Pending Upload, grouped by reason. Pairs with
// scripts/check-heartbeats.ts (scraper health): the cases that SHOULD pull but
// are stuck ("in_feed") are stuck because either the scraper is failing or the
// result isn't in the portal yet — heartbeats tell you which.
//
// Run: cd worker && npx tsx scripts/sample-sent-triage.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
if (!BASE || !SECRET) throw new Error("TRACKER_BASE_URL + WORKER_SHARED_SECRET required");

type Case = {
  caseId: string;
  patient: string;
  lab: string;
  scraper: string | null;
  accession: string | null;
  reason: string;
  pollStartsBy: string;
  window: { min: string | null; max: string | null };
  deliveredAt: string | null;
  collectionDate: string | null;
};

// Print order: the actionable buckets first.
const ORDER = ["in_feed", "no_accession", "not_scheduled", "manual_lab", "too_early", "past_grace"];
const TITLE: Record<string, string> = {
  in_feed: "PULL-ELIGIBLE (probed every cycle) — stuck = scraper failing OR not ready yet",
  no_accession: "NO ACCESSION — never enters the feed (enter the requisition #)",
  not_scheduled: "SCRAPER NOT SCHEDULED (e.g. Genova) — won't auto-pull",
  manual_lab: "MANUAL LAB (no scraper) — pull by hand",
  too_early: "TOO EARLY — poll window not open yet",
  past_grace: "PAST 60d GRACE — dropped from feed (overdue/verify)",
};

async function main() {
  const res = await request(`${BASE}/api/worker/sample-sent-triage`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(`triage ${res.statusCode}: ${(await res.body.text()).slice(0, 300)}`);
  }
  const { today, total, byReason, notes, cases } = (await res.body.json()) as {
    today: string;
    total: number;
    byReason: Record<string, number>;
    notes: Record<string, string>;
    cases: Case[];
  };

  console.log(`\n═══ Sample Sent triage — ${total} case(s) in the column, as of ${today} ═══\n`);
  for (const reason of ORDER) {
    const group = cases.filter((c) => c.reason === reason);
    if (group.length === 0) continue;
    console.log(`▌ ${TITLE[reason] ?? reason}  (${group.length})`);
    console.log(`  ${notes[reason] ?? ""}`);
    for (const c of group) {
      const w = c.window.min ? `${c.window.min}…${c.window.max ?? "?"}` : "?";
      const acc = c.accession ? `acc ${c.accession}` : "no-acc";
      const extra = reason === "too_early" ? ` polls ${c.pollStartsBy}` : reason === "past_grace" ? ` window ${w}` : "";
      console.log(`    • ${c.patient.padEnd(24)} ${(c.lab ?? "").padEnd(22)} ${acc}${extra}`);
    }
    console.log("");
  }

  // The headline: how many genuinely SHOULD be pulling and aren't.
  const inFeed = byReason["in_feed"] ?? 0;
  console.log("─────────────────────────────────────────────────────");
  console.log(`Summary: ${Object.entries(byReason).map(([r, n]) => `${r}=${n}`).join("  ")}`);
  if (inFeed > 0) {
    console.log(
      `\n⚠ ${inFeed} case(s) are PULL-ELIGIBLE but still in Sample Sent. Next: run` +
        ` 'npx tsx scripts/check-heartbeats.ts' — if a portal scraper is red, that's why.` +
        ` If green, the result likely isn't in the portal yet (or accession-mismatch — try "Find result" on the card).`,
    );
  } else {
    console.log("\nNo pull-eligible cases stuck — everything in Sample Sent is excluded for an explainable reason above.");
  }
}

main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
