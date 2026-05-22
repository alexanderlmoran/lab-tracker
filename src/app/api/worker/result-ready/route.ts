// Lab portal scraper reports a downloaded result PDF.
//
// Endpoint matches the contract in worker/src/tracker-client.ts → postResultReady.
// Side effects:
//   1. Upload PDF bytes to Supabase Storage (bucket: lab-pdfs)
//   2. Insert lab_case_pdfs row (attached_by = source)
//   3. Set lab_cases.lab_external_ref if not already set (accession #)
//   4. Append a lab_events row for the activity log
//
// The card lands in the "Pending Upload" column automatically — that column
// is computed from "has a non-superseded PDF and no approve audit row yet."
// This endpoint does NOT toggle any step booleans. Step advancement comes
// from FedEx delivery polling, not from the PDF arrival itself.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const STORAGE_BUCKET = "lab-pdfs";

const Body = z.object({
  caseId: z.string().uuid(),
  labExternalRef: z.string().min(1),
  pdfBase64: z.string().min(1),
  pdfFilename: z.string().min(1),
  resultIssuedAt: z.string().optional(),
  source: z.string().min(1),
  /** When true, this is a partial result (auto-toggles step2 instead of step4). */
  isPartial: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `bad body: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();

  const { data: kase, error: caseErr } = await db
    .from("lab_cases")
    .select("id, lab_external_ref")
    .eq("id", parsed.caseId)
    .single();
  if (caseErr || !kase) {
    return NextResponse.json({ ok: false, error: "case not found" }, { status: 404 });
  }

  const pdfBytes = Buffer.from(parsed.pdfBase64, "base64");
  if (pdfBytes.length === 0) {
    return NextResponse.json({ ok: false, error: "empty pdf" }, { status: 400 });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `${parsed.caseId}/${ts}-${parsed.pdfFilename}`;

  const { error: uploadErr } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadErr) {
    return NextResponse.json(
      { ok: false, error: `storage upload: ${uploadErr.message}` },
      { status: 500 },
    );
  }

  const { data: pdfRow, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .insert({
      case_id: parsed.caseId,
      storage_path: storagePath,
      source: parsed.source,
      external_ref: parsed.labExternalRef,
      filename: parsed.pdfFilename,
      size_bytes: pdfBytes.length,
      is_partial: parsed.isPartial ?? false,
      result_issued_at: parsed.resultIssuedAt ?? null,
      attached_by: parsed.source,
    })
    .select("id")
    .single();
  if (pdfErr || !pdfRow) {
    return NextResponse.json(
      { ok: false, error: `pdf row insert: ${pdfErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  if (!kase.lab_external_ref) {
    await db
      .from("lab_cases")
      .update({ lab_external_ref: parsed.labExternalRef })
      .eq("id", parsed.caseId);
  }

  // A PDF arriving from the scraper IS the signal that the lab has the
  // results — no point making staff click step 4 (or step 2 for partial)
  // by hand. Cascade: step4 implies step1 done; the form's setStepCompleted
  // path handles cascade properly via a server action, but in this worker
  // context we set the boolean directly and emit a step_toggled event so
  // the activity log reflects the auto-toggle. Idempotent — if step is
  // already true, the row just stays true.
  const stepToFlip = parsed.isPartial ? 2 : 4;
  const stepColumn =
    stepToFlip === 2 ? "step2_partial_received" : "step4_complete_received";

  // Read current step state to know if we're actually flipping or no-op.
  const { data: caseSteps } = await db
    .from("lab_cases")
    .select(stepColumn)
    .eq("id", parsed.caseId)
    .single();
  const stepAlreadyTrue = Boolean(
    (caseSteps as Record<string, boolean> | null)?.[stepColumn],
  );

  if (!stepAlreadyTrue) {
    await db
      .from("lab_cases")
      .update({ [stepColumn]: true })
      .eq("id", parsed.caseId);

    await db.from("lab_events").insert({
      case_id: parsed.caseId,
      kind: "step_toggled",
      step: stepToFlip,
      completed: true,
      actor: parsed.source,
      note: `Auto-set on result PDF arrival (${parsed.pdfFilename})`,
      meta: {
        pdf_id: pdfRow.id,
        external_ref: parsed.labExternalRef,
        is_partial: parsed.isPartial ?? false,
      },
    });
  }

  await db.from("lab_events").insert({
    case_id: parsed.caseId,
    kind: "case_edited",
    actor: parsed.source,
    note: `Result PDF attached (${parsed.pdfFilename}, ${pdfBytes.length} bytes)`,
    meta: {
      pdf_id: pdfRow.id,
      external_ref: parsed.labExternalRef,
      result_issued_at: parsed.resultIssuedAt ?? null,
    },
  });

  return NextResponse.json({ ok: true, pdfId: pdfRow.id, storagePath });
}
