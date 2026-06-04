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
  // No exact lab_name filter at the DB: the staff-typed lab_name ("Access
  // Custom", "access · custom") often doesn't equal the scraper's canonical
  // portal, so we normalize and match in JS (sameLab) instead.
  const { data, error } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_dob, patient_email, lab_name, lab_external_ref, step1_sample_sent, step2_partial_received, step4_complete_received, expected_result_at_min, expected_result_at_max",
    )
    .not("lab_external_ref", "is", null)
    .eq("step5_complete_uploaded", false)
    .is("archived_at", null)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // A case is scrapeable when either:
  //   (a) staff already marked results received (step2/step4) — the classic gate, OR
  //   (b) it's in its RESULT WINDOW: sample sent, accession set, today is past the
  //       predicted earliest result date and not more than GRACE_DAYS past the
  //       latest — so the scheduled scrape auto-detects results the moment the
  //       portal has them, without a human first ticking "results received".
  //       The scraper only stages a PDF that matches the accession, so probing a
  //       not-yet-ready case is a safe no-op. The window bounds portal load.
  const today = new Date().toISOString().slice(0, 10);
  const GRACE_DAYS = 21;
  const graceFloor = new Date(Date.now() - GRACE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const inResultWindow = (c: Row) =>
    c.step1_sample_sent &&
    !c.step2_partial_received &&
    !c.step4_complete_received &&
    !!c.expected_result_at_min &&
    c.expected_result_at_min <= today &&
    (!c.expected_result_at_max || c.expected_result_at_max >= graceFloor);

  const cases = ((data ?? []) as Row[])
    .filter((c) => sameLab(c.lab_name, lab))
    .filter((c) => c.step4_complete_received || c.step2_partial_received || inResultWindow(c))
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
    }));

  return NextResponse.json({ ok: true, cases });
}
