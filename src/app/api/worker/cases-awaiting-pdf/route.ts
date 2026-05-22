// Discovery endpoint for the test-mode auto-attach watcher.
//
// Production answer: the real Access (and friends) scrapers know which cases
// to grab PDFs for by polling lab portals directly. In the local test loop
// we don't have a real lab order, so we need the tracker to tell us:
//   "Which cases have advanced to the 'PDF expected' state but don't have
//    one attached yet?"
//
// Criteria for a case to surface here:
//   - lab_external_ref is set (staff has typed in the accession)
//   - step4_complete_received OR step2_partial_received is true
//   - step5_complete_uploaded is false
//   - no non-superseded lab_case_pdfs row exists
//   - case was created in the last AUTO_ATTACH_WINDOW_MS (default 30 min)
//
// The recency filter is a SAFETY GATE: even when the auto-attach watcher
// is running, it should never touch cases that pre-date this dev session.
// If a real (older) case is waiting for a real scraper, the watcher won't
// stomp it with the canned test PDF. Demo cases — booked seconds ago —
// pass through.
//
// Auth: Bearer WORKER_SHARED_SECRET — same as other /api/worker/* routes.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

// 30 minutes. Tunable via env if a demo runs long.
const AUTO_ATTACH_WINDOW_MS = Number(
  process.env.AUTO_ATTACH_WINDOW_MS ?? "1800000",
);

type ResponseCase = {
  caseId: string;
  labName: string;
  patientName: string;
  patientDob: string | null;
  collectionDate: string | null;
  labExternalRef: string;
};

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  const recencyCutoff = new Date(
    Date.now() - AUTO_ATTACH_WINDOW_MS,
  ).toISOString();

  // Pull candidate cases — narrow at the DB to keep memory bounded.
  // The created_at filter is the SAFETY GATE described in the header.
  const { data: cases, error } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_dob, lab_name, collection_date, lab_external_ref, step2_partial_received, step4_complete_received, step5_complete_uploaded, archived_at, created_at, deleted_at",
    )
    .not("lab_external_ref", "is", null)
    .eq("step5_complete_uploaded", false)
    .is("archived_at", null)
    .is("deleted_at", null)
    .gte("created_at", recencyCutoff);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    patient_name: string;
    patient_dob: string | null;
    lab_name: string;
    collection_date: string | null;
    lab_external_ref: string;
    step2_partial_received: boolean;
    step4_complete_received: boolean;
    step5_complete_uploaded: boolean;
    created_at: string;
    deleted_at: string | null;
  };
  const candidates = ((cases ?? []) as Row[]).filter(
    (c) => c.step4_complete_received || c.step2_partial_received,
  );

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, cases: [] });
  }

  // For each candidate, check whether a non-superseded PDF already exists.
  const caseIds = candidates.map((c) => c.id);
  const { data: pdfs, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .select("case_id")
    .in("case_id", caseIds)
    .is("superseded_at", null);
  if (pdfErr) {
    return NextResponse.json({ ok: false, error: pdfErr.message }, { status: 500 });
  }
  const hasPdf = new Set((pdfs ?? []).map((p) => p.case_id as string));

  const result: ResponseCase[] = candidates
    .filter((c) => !hasPdf.has(c.id))
    .map((c) => ({
      caseId: c.id,
      labName: c.lab_name,
      patientName: c.patient_name,
      patientDob: c.patient_dob,
      collectionDate: c.collection_date,
      labExternalRef: c.lab_external_ref,
    }));

  return NextResponse.json({ ok: true, cases: result });
}
