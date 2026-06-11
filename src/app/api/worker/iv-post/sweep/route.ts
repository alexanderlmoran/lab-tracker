// IV auto-post sweep. Enqueues a post job for every IV session that has
// occurred but has no PB note yet — so a note never goes MISSING even if no one
// charted it. The drain worker then posts each (flagged incomplete) for the
// confidently-matched patients (>=95) and holds the rest for review.
//
// Eligibility: not cancelled, not EBOO/EBO2 (manual), not an add-on (those
// attach to the base note), no pb_note_id yet, session_date within the window,
// and no in-flight/held/done job already (don't churn human-held ones; a failed
// job IS retried).
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.  Query: ?days=N (window, default 2),
// ?dryRun=1 (report only, write nothing).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const days = Math.max(0, Math.min(30, Number(url.searchParams.get("days") ?? "2")));
  const dryRun = url.searchParams.get("dryRun") === "1";

  const db = getSupabaseAdmin();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - days);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = today.toISOString().slice(0, 10);

  const { data: sessions, error } = await db
    .from("iv_sessions")
    .select("id, service_name, session_date, kind")
    .eq("cancelled", false)
    .eq("is_add_on", false)
    .not("kind", "in", "(ebo,addon)")
    .is("pb_note_id", null)
    .gte("session_date", fromStr)
    .lte("session_date", toStr);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const sess = sessions ?? [];
  if (sess.length === 0) return NextResponse.json({ ok: true, window: { from: fromStr, to: toStr }, eligible: 0, enqueued: 0 });

  const ids = sess.map((s) => s.id);
  const { data: jobs } = await db.from("iv_post_jobs").select("session_id, status").in("session_id", ids);
  const statusBySession = new Map((jobs ?? []).map((j) => [j.session_id, j.status]));
  // Enqueue only sessions with no job, or a previously FAILED job (retry). Skip
  // queued/claimed (in flight), held (waiting for human review), succeeded.
  const toEnqueue = sess.filter((s) => {
    const st = statusBySession.get(s.id);
    return !st || st === "failed";
  });

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      window: { from: fromStr, to: toStr },
      eligible: sess.length,
      wouldEnqueue: toEnqueue.length,
      sample: toEnqueue.slice(0, 10).map((s) => ({ service: s.service_name, date: s.session_date })),
    });
  }

  for (const s of toEnqueue) {
    await db
      .from("iv_post_jobs")
      .upsert({ session_id: s.id, status: "queued", last_error: null, finished_at: null, claimed_at: null }, { onConflict: "session_id" });
  }
  return NextResponse.json({ ok: true, window: { from: fromStr, to: toStr }, eligible: sess.length, enqueued: toEnqueue.length });
}
