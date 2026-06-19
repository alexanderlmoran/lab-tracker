// Sample Sent triage — read-only diagnostic. Classifies EVERY case currently in
// the "Sample Sent" column by WHY it is / isn't being auto-pulled, so staff can
// see at a glance which ones should have results waiting vs which are expected to
// sit (manual lab, no accession, too early). Uses the SAME window math as the
// scrape feed (@/lib/labs/result-window) so "in_feed" here == what the worker probes.
//
// Auth: Bearer ${WORKER_SHARED_SECRET}. The worker script scripts/sample-sent-triage.ts
// prints this; or GET it directly with the worker bearer.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import { effectiveWindow, inResultWindow, pollStartsBy, type ResultWindowCase } from "@/lib/labs/result-window";

export const dynamic = "force-dynamic";

// Labs the SCHEDULED scrape loop runs by default (worker SCRAPE_LABS, scrape-all.ts).
// A lab with a scraper key NOT in here (Genova) has code but isn't auto-run.
const SCHEDULED_SCRAPERS = new Set(["access", "cyrex", "spectracell", "glycanage", "doctorsdata", "vibrant"]);

type Reason =
  | "in_feed" // pull-eligible: in window + accessioned + scheduled scraper → the worker probes it each loop
  | "no_accession" // no lab_external_ref and not Vibrant → never enters the feed
  | "manual_lab" // no scraper for this lab → must be pulled by hand
  | "not_scheduled" // has a scraper but it's not in the scheduled loop (Genova)
  | "too_early" // accessioned + scraped, but poll window hasn't opened yet
  | "past_grace"; // >60d past predicted max → dropped from the feed (overdue)

const REASON_NOTE: Record<Reason, string> = {
  in_feed: "PROBED each scrape cycle — if results are in the portal and it's still here, the scraper is failing OR results aren't ready yet (check scraper health + Find result).",
  no_accession: "No accession # — never enters the scrape feed. Enter the requisition/accession on the card (Vibrant is the only DOB-matched exception).",
  manual_lab: "No scraper for this lab — pull by hand and upload (e.g. Kennedy Krieger, RGCC, ReliGen).",
  not_scheduled: "Has a scraper but it's not in the scheduled loop (e.g. Genova needs a session) — won't auto-pull until scheduled.",
  too_early: "Poll window hasn't opened yet — will start auto-pulling on the listed date.",
  past_grace: "Over 60 days past the predicted result window — dropped from the feed. Likely overdue/lost; verify or archive.",
};

type Row = ResultWindowCase & {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  lab_external_ref: string | null;
  step5_complete_uploaded: boolean;
};

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  // The "Sample Sent" column = step1 true, step2/step4/step5 all false, active.
  const { data, error } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_dob, lab_name, lab_external_ref, step1_sample_sent, step2_partial_received, step4_complete_received, step5_complete_uploaded, expected_result_at_min, expected_result_at_max, collection_date, tracking_delivered_at, created_at",
    )
    .eq("step1_sample_sent", true)
    .eq("step2_partial_received", false)
    .eq("step4_complete_received", false)
    .eq("step5_complete_uploaded", false)
    .is("archived_at", null)
    .is("deleted_at", null);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const today = new Date().toISOString().slice(0, 10);

  const classify = (c: Row): Reason => {
    const scraper = probeKeyForLab(c.lab_name);
    if (!scraper) return "manual_lab";
    if (!c.lab_external_ref) {
      // Vibrant auto-pulls accession-less via DOB; every other lab needs the accession.
      if (scraper === "vibrant" && c.patient_dob) return inResultWindow(c, today) ? "in_feed" : pollStartsBy(c) > today ? "too_early" : "past_grace";
      return "no_accession";
    }
    if (!SCHEDULED_SCRAPERS.has(scraper)) return "not_scheduled";
    if (inResultWindow(c, today)) return "in_feed";
    return pollStartsBy(c) > today ? "too_early" : "past_grace";
  };

  const cases = (data ?? []).map((c) => {
    const row = c as Row;
    const reason = classify(row);
    const win = effectiveWindow(row);
    return {
      caseId: row.id,
      patient: row.patient_name,
      lab: row.lab_name,
      scraper: probeKeyForLab(row.lab_name),
      accession: row.lab_external_ref,
      reason,
      pollStartsBy: pollStartsBy(row),
      window: win,
      deliveredAt: row.tracking_delivered_at,
      collectionDate: row.collection_date,
    };
  });

  const byReason: Record<string, number> = {};
  for (const c of cases) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    today,
    total: cases.length,
    byReason,
    notes: REASON_NOTE,
    cases,
  });
}
