// IV auto-post sweep. Enqueues a post job for every IV session a human has
// CHARTED (charting_status='ready') that has occurred. The drain worker then
// posts each for the confidently-matched patients (>=95) and holds the rest for
// review.
//
// SAFETY STOPGAP (Alex 2026-06-22): this used to ALSO enqueue un-charted
// placeholders (pb_note_id IS NULL) "so a note never goes missing" — but that
// auto-posted incomplete notes carrying FABRICATED vitals. Un-charted IVs now
// wait on the board for a human to chart them; explicit "Approve & post" still
// posts anything on demand.
//
// Eligibility: not cancelled, not EBOO/EBO2 (manual), not an add-on (those
// attach to the base note), charting_status='ready', session_date within the
// window, and no in-flight/held/done job already (don't churn human-held ones; a
// failed job IS retried).
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.  Query: ?days=N (lookback window, default
// 2), ?minAgeMin=N (only enqueue IVs that OCCURRED at least N min ago — never a
// future appointment; default 60), ?dryRun=1 (report only, write nothing).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

/** Wall-clock "now" in clinic time (America/New_York), as epoch ms but labeled
 *  as if UTC — because iv_sessions.start_at is the Zenoti local clock stored
 *  with a +00:00 offset (e.g. an 11am ET appt is "11:00:00+00:00"). Comparing
 *  both in this same frame is correct. */
function nowEasternAsUtcMs(): { ms: number; date: string } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const ms = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  const date = `${String(g("year"))}-${String(g("month")).padStart(2, "0")}-${String(g("day")).padStart(2, "0")}`;
  return { ms, date };
}

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const days = Math.max(0, Math.min(30, Number(url.searchParams.get("days") ?? "2")));
  const minAgeMin = Math.max(0, Math.min(1440, Number(url.searchParams.get("minAgeMin") ?? "60")));
  const dryRun = url.searchParams.get("dryRun") === "1";

  const db = getSupabaseAdmin();
  const { ms: nowMs, date: todayEt } = nowEasternAsUtcMs();
  const cutoffMs = nowMs - minAgeMin * 60_000;
  const from = new Date(nowMs);
  from.setUTCDate(from.getUTCDate() - days);
  const fromStr = from.toISOString().slice(0, 10);

  const { data: sessions, error } = await db
    .from("iv_sessions")
    .select("id, service_name, session_date, kind, start_at, charting_status, pb_note_id")
    .eq("cancelled", false)
    .eq("is_add_on", false)
    .not("kind", "in", "(ebo,addon)")
    // Only AUTO-post what a human charted. saveIvChart sets 'ready' on chart AND
    // on a re-chart (which flips a 'posted' note back to 'ready'); the re-post
    // branch below updates the existing note in place. A successful post sets
    // 'posted', so this converges. Un-charted ('pending') sessions are excluded.
    .eq("charting_status", "ready")
    .gte("session_date", fromStr);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // OCCURRED guard: only IVs that have already happened (>= minAgeMin ago). A
  // missing start_at falls back to the day having arrived. This is what stops the
  // sweep from posting a note for an appointment still in the future.
  const occurred = (s: { start_at: string | null; session_date: string }) =>
    s.start_at ? new Date(s.start_at).getTime() <= cutoffMs : s.session_date <= todayEt;
  const sess = (sessions ?? []).filter(occurred);
  if (sess.length === 0) return NextResponse.json({ ok: true, window: { from: fromStr, minAgeMin }, eligible: 0, enqueued: 0 });

  const ids = sess.map((s) => s.id);
  const { data: jobs } = await db.from("iv_post_jobs").select("session_id, status").in("session_id", ids);
  const statusBySession = new Map((jobs ?? []).map((j) => [j.session_id, j.status]));
  // Enqueue sessions with no job or a previously FAILED job (retry). A RE-POST
  // (note already posted, since re-charted to 'ready') re-enqueues even over a
  // SUCCEEDED job — that success was the placeholder; we're pushing the charted
  // data now. Never disturb queued/claimed (in flight) or held (human review).
  const toEnqueue = sess.filter((s) => {
    const st = statusBySession.get(s.id);
    if (st === "queued" || st === "claimed" || st === "held") return false;
    const isRepost = !!s.pb_note_id && s.charting_status === "ready";
    return isRepost || !st || st === "failed";
  });

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      window: { from: fromStr, minAgeMin },
      eligible: sess.length,
      wouldEnqueue: toEnqueue.length,
      sample: toEnqueue.slice(0, 10).map((s) => ({ service: s.service_name, date: s.session_date, start_at: s.start_at })),
    });
  }

  for (const s of toEnqueue) {
    await db
      .from("iv_post_jobs")
      .upsert({ session_id: s.id, status: "queued", last_error: null, finished_at: null, claimed_at: null }, { onConflict: "session_id" });
  }
  return NextResponse.json({ ok: true, window: { from: fromStr, minAgeMin }, eligible: sess.length, enqueued: toEnqueue.length });
}
