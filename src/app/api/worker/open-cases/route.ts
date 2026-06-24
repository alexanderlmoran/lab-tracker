// Production "cases awaiting a PDF scrape" feed for the worker.
//
// The worker's fetchOpenCases() GETs this per lab; /run, the Settings Dry-run,
// and the scheduled scrape-all all depend on it. A case is in scope when:
//   - lab_external_ref is set (staff entered the accession)
//   - results have arrived (step2 partial OR step4 complete received)
//   - it hasn't been uploaded to PB yet (step5 false)
//   - it isn't archived or soft-deleted
// Unlike the dev-only /cases-awaiting-pdf endpoint, there is NO created_at
// recency gate — production pulls EVERY matching case (per Alex 2026-06-03).
// Returns the worker's OpenCase shape; fields the scrapers don't use are null.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { sameLab } from "@/lib/scrapers/normalize-lab";
import { partialCompletionCheckDue } from "@/lib/labs/catalog";
import { inResultWindow } from "@/lib/labs/result-window";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  patient_email: string | null;
  lab_name: string;
  lab_external_ref: string | null;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step4_complete_received: boolean;
  expected_result_at_min: string | null;
  expected_result_at_max: string | null;
  collection_date: string | null;
  tracking_delivered_at: string | null;
  created_at: string;
  dismissed_refs: string[] | null;
};

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const lab = new URL(request.url).searchParams.get("lab");
  if (!lab) {
    return NextResponse.json({ ok: false, error: "lab query param required" }, { status: 400 });
  }

  const db = getSupabaseAdmin();
  const SELECT_COLS =
    "id, patient_name, patient_dob, patient_email, lab_name, lab_external_ref, step1_sample_sent, step2_partial_received, step4_complete_received, expected_result_at_min, expected_result_at_max, collection_date, tracking_delivered_at, created_at, dismissed_refs";
  // No exact lab_name filter at the DB: the staff-typed lab_name ("Access
  // Custom", "access · custom") often doesn't equal the scraper's canonical
  // portal, so we normalize and match in JS (sameLab) instead.
  const { data, error } = await db
    .from("lab_cases")
    .select(SELECT_COLS)
    .not("lab_external_ref", "is", null)
    .eq("step5_complete_uploaded", false)
    .is("archived_at", null)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Vibrant CAN match by patient name + DOB (DOB-verified), so accession-LESS
  // Vibrant cards — which the accession-gated query above skips — can still
  // auto-pull. Pull them in a bounded second query (Vibrant lab names, DOB set,
  // created within ~120d) ONLY for the Vibrant feed. The scraper requires an
  // unambiguous single-order match, and result-ready writes the matched
  // accession back, so the next scrape is accession-matched.
  let accessionlessVibrant: unknown[] = [];
  if (sameLab(lab, "Vibrant")) {
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const { data: vless } = await db
      .from("lab_cases")
      .select(SELECT_COLS)
      .is("lab_external_ref", null)
      .ilike("lab_name", "%vibrant%")
      .not("patient_dob", "is", null)
      .eq("step5_complete_uploaded", false)
      .is("archived_at", null)
      .is("deleted_at", null)
      .gte("created_at", since);
    accessionlessVibrant = vless ?? [];
  }

  // A case is scrapeable when either staff already marked results received
  // (step2/step4), OR it's inside its RESULT WINDOW (sample sent, accession set,
  // poll-start reached, not past the grace floor). Window/poll math is shared
  // with the sample-sent triage — see @/lib/labs/result-window.
  const rows = [...((data ?? []) as Row[]), ...(accessionlessVibrant as Row[])].filter((c) =>
    sameLab(c.lab_name, lab),
  );

  // Staged completion re-checks — Access only (backlog #20). Access drips a
  // partial first then back-fills the complete panel over ~2 weeks. Once a
  // partial has landed (step2 true, step4 false) the case otherwise stays in the
  // scrape feed EVERY loop until the complete panel arrives — needlessly
  // hammering the portal. Instead we re-check only on a staged cadence after the
  // first partial (~day 2, day 4–7, then day 14+), anchored on when the partial
  // PDF actually arrived. Scoped to the Access feed so other drip labs (Vibrant
  // Zoomers) keep their prior always-include behavior.
  const stageAccessPartials = sameLab(lab, "Access");
  const partialOnlyIds = stageAccessPartials
    ? rows
        .filter((c) => c.step2_partial_received && !c.step4_complete_received)
        .map((c) => c.id)
    : [];
  const partialAtById = new Map<string, Date>();
  if (partialOnlyIds.length > 0) {
    const { data: pdfRows } = await db
      .from("lab_case_pdfs")
      .select("case_id, attached_at")
      .in("case_id", partialOnlyIds)
      .eq("is_partial", true)
      .is("superseded_at", null)
      .order("attached_at", { ascending: false });
    for (const p of (pdfRows ?? []) as { case_id: string; attached_at: string }[]) {
      // Rows are newest-first; keep the FIRST partial seen per case (its most
      // recent partial = the cadence anchor).
      if (!partialAtById.has(p.case_id)) {
        partialAtById.set(p.case_id, new Date(p.attached_at));
      }
    }
  }

  // Is a partial-only case due for a completion re-check right now? Off the
  // Access feed (or when a partial was marked by hand with no PDF anchor) we
  // keep the old always-include behavior so nothing is silently dropped.
  const completionCheckDue = (c: Row): boolean => {
    if (!stageAccessPartials) return true;
    const partialAt = partialAtById.get(c.id);
    if (!partialAt) return true;
    return partialCompletionCheckDue(partialAt);
  };

  const cases = rows
    .filter((c) =>
      c.step4_complete_received
        ? true
        : c.step2_partial_received
          ? completionCheckDue(c)
          : inResultWindow(c),
    )
    .map((c) => ({
      caseId: c.id,
      patientName: c.patient_name,
      patientDob: c.patient_dob,
      patientEmail: c.patient_email ?? "",
      labName: c.lab_name,
      labExternalRef: c.lab_external_ref,
      sampleSentAt: null,
      trackingDeliveredAt: null,
      expectedResultAtMin: null,
      expectedResultAtMax: null,
      dismissedRefs: c.dismissed_refs ?? [],
    }));

  // SURFACE the silent gap: results-ready cases (step2/step4) with a NULL
  // accession are hard-gated OUT of the scrape feed above (the main query
  // requires lab_external_ref IS NOT NULL). The only exception that DOES get
  // scraped is the Vibrant+DOB path; everything else is invisible — staff
  // could only find it via a CLI script. We DON'T change the gate (a missing
  // accession genuinely can't be portal-matched for most labs); we just emit a
  // count + list so the board / dry-run can show "N results-ready cases need
  // an accession entered." Bounded to ~180d to avoid scanning dead history.
  const buildableIds = new Set(cases.map((c) => c.caseId));
  const noAccessionSince = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: missingRows } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_email, lab_name, step2_partial_received, step4_complete_received, collection_date, created_at",
    )
    .is("lab_external_ref", null)
    .eq("step5_complete_uploaded", false)
    .is("archived_at", null)
    .is("deleted_at", null)
    .or("step2_partial_received.eq.true,step4_complete_received.eq.true")
    .gte("created_at", noAccessionSince);
  const noAccession = ((missingRows ?? []) as Array<{
    id: string;
    patient_name: string;
    patient_email: string | null;
    lab_name: string;
    step2_partial_received: boolean;
    step4_complete_received: boolean;
    collection_date: string | null;
    created_at: string;
  }>)
    // Only this lab's feed, and only cases not already scraped via the Vibrant
    // accession-less path (those aren't actually stuck).
    .filter((c) => sameLab(c.lab_name, lab) && !buildableIds.has(c.id))
    .map((c) => ({
      caseId: c.id,
      patientName: c.patient_name,
      patientEmail: c.patient_email ?? "",
      labName: c.lab_name,
      resultsReady: c.step4_complete_received ? "complete" : "partial",
      collectionDate: c.collection_date,
    }));

  return NextResponse.json({
    ok: true,
    cases,
    noAccessionCount: noAccession.length,
    noAccession,
  });
}
