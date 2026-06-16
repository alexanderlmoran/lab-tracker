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
import { maybeFireNadiaAllReceived, notifyCompleteUpload } from "@/lib/workflow";
import { accessionSiblingIds } from "@/lib/labs/siblings";

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

  // Idempotency: a re-delivered outcome for an already-terminal job (worker
  // retried after a lost response) must not re-run the step flips, the sibling
  // cascade, or the Nadia/staff notification emails.
  if (job.status === "succeeded" || job.status === "failed") {
    return NextResponse.json({ ok: true, alreadyRecorded: true });
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

    // Cascade to same-accession sibling cards: the result is now on PB, so the
    // duplicate cards for this physical order are covered — advance them too
    // (without re-uploading) so they don't orphan in Pending Upload. Best-effort.
    try {
      const sibIds = (await accessionSiblingIds(job.case_id)).filter((id) => id !== job.case_id);
      if (sibIds.length) {
        const now = new Date().toISOString();
        await db
          .from("lab_case_pdfs")
          .update({ superseded_at: now, superseded_reason: "covered by same-accession sibling uploaded to PB" })
          .in("case_id", sibIds)
          .is("superseded_at", null);
        await db.from("lab_cases").update({ step5_complete_uploaded: true }).in("id", sibIds);
        for (const id of sibIds) {
          await db.from("lab_events").insert({
            case_id: id,
            kind: "step_toggled",
            step: 5,
            completed: true,
            actor: "worker:pb-upload",
            note: `Complete — same-accession sibling uploaded to PB (labrequest=${parsed.pbLabRequestId})`,
          });
        }
      }
    } catch (err) {
      console.error("[pb-upload/result] sibling cascade failed", err);
    }

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

    // Backlog #21 — notify staff that the complete result landed on PB.
    // Best-effort; the upload is already recorded.
    try {
      await notifyCompleteUpload(job.case_id, "worker:pb-upload", {
        pbLabRequestId: parsed.pbLabRequestId,
      });
    } catch (err) {
      console.error("[pb-upload/result] complete-upload notify failed", err);
    }

    // If this case was posted from the inbox, flip its inbound row from the
    // "queued_to_pb" (posting…) interim state to a VERIFIED posted state. No-op
    // for non-inbox cases (no matching inbound row). Best-effort.
    try {
      await db
        .from("inbound_emails")
        .update({ applied_action: "posted_to_pb", parser_error: null })
        .eq("matched_case_id", job.case_id)
        .eq("applied_action", "queued_to_pb");
    } catch (err) {
      console.error("[pb-upload/result] inbound posted-flip failed", err);
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

  // If this came from the inbox, surface the failure on the inbound row instead
  // of leaving it reading "posting…" forever (or, pre-fix, a false "posted").
  // Back to actionable ("to review") + a "post failed" marker + the error, so
  // staff can fix the patient match / create the PB account and re-post.
  try {
    await db
      .from("inbound_emails")
      .update({ parser_status: "parsed", applied_action: "pb_failed", parser_error: parsed.error.slice(0, 500) })
      .eq("matched_case_id", job.case_id)
      .eq("applied_action", "queued_to_pb");
  } catch (err) {
    console.error("[pb-upload/result] inbound failed-flip failed", err);
  }

  return NextResponse.json({ ok: true });
}
