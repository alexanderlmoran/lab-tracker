// Worker poller endpoint: claim the next queued PB upload job.
//
// Atomic claim via SQL update: we flip 'queued' → 'claimed' and return the
// row only if the update affected one row. This survives concurrent pollers
// without needing advisory locks. Returns 204 No Content when the queue is
// empty.
//
// The response includes everything the worker needs to call uploadPdfToPb()
// without further DB access: patient name + DOB, lab name, collection date,
// and a short-lived signed URL for the PDF in Supabase Storage.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const STORAGE_BUCKET = "lab-pdfs";
const SIGNED_URL_TTL_SECONDS = 600;

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();

  // Pick the oldest queued job. PostgREST doesn't expose UPDATE...RETURNING
  // with row-locking, so we do a two-step: select id of oldest, then update
  // that specific id from queued→claimed (filter on status='queued' so two
  // concurrent pollers can't both win).
  const { data: candidate, error: pickErr } = await db
    .from("pb_upload_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pickErr) {
    return NextResponse.json({ ok: false, error: pickErr.message }, { status: 500 });
  }
  if (!candidate) {
    return new NextResponse(null, { status: 204 });
  }

  const { data: claimed, error: claimErr } = await db
    .from("pb_upload_jobs")
    .update({
      status: "claimed",
      claimed_at: new Date().toISOString(),
      attempts: 1,
    })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("id, case_id, pdf_id, attempts")
    .maybeSingle();

  if (claimErr) {
    return NextResponse.json({ ok: false, error: claimErr.message }, { status: 500 });
  }
  if (!claimed) {
    // Lost the race — another poller claimed it. Tell the worker to try again.
    return new NextResponse(null, { status: 204 });
  }

  // Bump attempts properly (the update above sets it to 1 unconditionally,
  // which is fine for first-claim but wrong on retry). Re-fetch and adjust.
  const { data: pre } = await db
    .from("pb_upload_jobs")
    .select("attempts")
    .eq("id", claimed.id)
    .single();
  if (pre && typeof pre.attempts === "number" && pre.attempts !== 1) {
    await db
      .from("pb_upload_jobs")
      .update({ attempts: pre.attempts + 1 })
      .eq("id", claimed.id);
  }

  // Hydrate case + pdf details for the worker.
  const { data: kase, error: caseErr } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_dob, lab_name, lab_external_ref, collection_date, zenoti_service_name",
    )
    .eq("id", claimed.case_id)
    .single();
  if (caseErr || !kase) {
    return NextResponse.json(
      { ok: false, error: `case lookup failed: ${caseErr?.message ?? "missing"}` },
      { status: 500 },
    );
  }

  const { data: pdf, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .select("id, storage_path, filename, external_ref")
    .eq("id", claimed.pdf_id)
    .single();
  if (pdfErr || !pdf) {
    return NextResponse.json(
      { ok: false, error: `pdf lookup failed: ${pdfErr?.message ?? "missing"}` },
      { status: 500 },
    );
  }

  const { data: signed, error: signErr } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(pdf.storage_path as string, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { ok: false, error: `signed url failed: ${signErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    job: {
      id: claimed.id,
      caseId: claimed.case_id,
      pdfId: claimed.pdf_id,
      patientName: kase.patient_name,
      patientDob: kase.patient_dob,
      labName: kase.lab_name,
      // Verbatim Zenoti service ("Labs - Access Custom") — worker uses
      // this to build a richer PB title than bare labName.
      zenotiServiceName: (kase.zenoti_service_name as string | null) ?? null,
      collectionDate: kase.collection_date,
      // PDF-attached accession (preferred — what's actually printed on
      // the document). Falls back to the case's lab_external_ref if a
      // human typed the accession but no PDF row has carried it yet.
      // "manual" is the placeholder manual uploads stamp on the PDF row,
      // not an accession — skip it so PB titles never say "Acc#manual".
      accession:
        ((pdf.external_ref as string | null) === "manual"
          ? null
          : (pdf.external_ref as string | null)) ??
        (kase.lab_external_ref as string | null) ??
        null,
      pdfFilename: (pdf.filename as string | null) ?? "lab-report.pdf",
      pdfSignedUrl: signed.signedUrl,
    },
  });
}
