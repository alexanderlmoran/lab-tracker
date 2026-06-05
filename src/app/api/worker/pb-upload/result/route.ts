// Worker reports the outcome of a PB upload job.
//
// On success:
//   - pb_upload_jobs row → status 'succeeded', finished_at = now
//   - lab_cases.step5_complete_uploaded = true
//   - lab_events row 'step_toggled' (so the activity panel reflects it)
//
// On failure:
//   - pb_upload_jobs row → status 'failed', last_error captured
//   - lab_case_audit row 'disapprove_upload_failed' so the modal shows Retry

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { maybeFireNadiaAllReceived } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("success"),
    jobId: z.string().uuid(),
    pbLabRequestId: z.string(),
    pbPatientId: z.string(),
  }),
  z.object({
    outcome: z.literal("failure"),
    jobId: z.string().uuid(),
    error: z.string().min(1).max(2000),
  }),
]);

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

  const { data: job, error: jobErr } = await db
    .from("pb_upload_jobs")
    .select("id, case_id, pdf_id, status")
    .eq("id", parsed.jobId)
    .single();
  if (jobErr || !job) {
    return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  }

  if (parsed.outcome === "success") {
    await db
      .from("pb_upload_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", job.id);

    await db
      .from("lab_cases")
      .update({ step5_complete_uploaded: true })
      .eq("id", job.case_id);

    await db.from("lab_events").insert({
      case_id: job.case_id,
      kind: "step_toggled",
      step: 5,
      completed: true,
      actor: "worker:pb-upload",
      note: `Uploaded to PracticeBetter (labrequest=${parsed.pbLabRequestId})`,
      meta: {
        pb_lab_request_id: parsed.pbLabRequestId,
        pb_patient_id: parsed.pbPatientId,
        job_id: job.id,
        pdf_id: job.pdf_id,
      },
    });

    // Fire the step-5 workflow gate (Nadia "all labs received" → confirm link)
    // that the UI step-toggle fires but this automated path previously skipped —
    // so a batch completing via Approve OR the engine's auto-post still triggers
    // it. Guarded inside (only when ALL the patient's labs are at step 5, and
    // deduped on an outstanding token) and best-effort (never blocks the upload).
    try {
      await maybeFireNadiaAllReceived(job.case_id, "worker:pb-upload");
    } catch (err) {
      console.error("[pb-upload/result] nadia trigger failed", err);
    }

    return NextResponse.json({ ok: true });
  }

  // outcome === "failure"
  await db
    .from("pb_upload_jobs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      last_error: parsed.error,
    })
    .eq("id", job.id);

  await db.from("lab_case_audit").insert({
    case_id: job.case_id,
    pdf_id: job.pdf_id,
    action: "disapprove_upload_failed",
    actor_label: "worker:pb-upload",
    notes: parsed.error.slice(0, 500),
    meta: { job_id: job.id },
  });

  return NextResponse.json({ ok: true });
}
