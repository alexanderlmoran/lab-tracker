// IV post-job result endpoint. The worker reports the grading + post outcome:
//   success → note created in PB (score >= 95, clear match)
//   held    → match below 95 / ambiguous → wait for human review
//   failed  → error (no reference scaffold, PB error, etc.)
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
  outcome: z.enum(["success", "held", "failed"]),
  pbNoteId: z.string().nullable().optional(),
  pbClientRecordId: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let p: z.infer<typeof Body>;
  try { p = Body.parse(await request.json()); }
  catch (e) { return NextResponse.json({ ok: false, error: `Invalid body: ${e instanceof Error ? e.message : "?"}` }, { status: 400 }); }

  const db = getSupabaseAdmin();
  const now = new Date().toISOString();

  const jobStatus = p.outcome === "success" ? "succeeded" : p.outcome === "held" ? "held" : "failed";
  await db
    .from("iv_post_jobs")
    .update({
      status: jobStatus,
      match_score: p.score ?? null,
      match_reason: p.reason ?? null,
      pb_note_id: p.pbNoteId ?? null,
      pb_client_record_id: p.pbClientRecordId ?? null,
      last_error: p.outcome === "failed" ? p.error ?? "unknown" : null,
      finished_at: now,
    })
    .eq("id", p.jobId);

  // Reflect on the session.
  if (p.outcome === "success") {
    await db
      .from("iv_sessions")
      // Clear create_pb_account: the account now exists (created or matched), so a
      // future re-post must never create a second one.
      .update({ charting_status: "posted", pb_note_id: p.pbNoteId ?? null, pb_client_record_id: p.pbClientRecordId ?? null, posted_at: now, create_pb_account: false })
      .eq("id", p.sessionId);
  } else if (p.outcome === "failed") {
    await db.from("iv_sessions").update({ last_error: p.error ?? "post failed" }).eq("id", p.sessionId);
  }
  // held: leave charting_status='ready'; the job row carries score/reason for review.

  return NextResponse.json({ ok: true });
}
