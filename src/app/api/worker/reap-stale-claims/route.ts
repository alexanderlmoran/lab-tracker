// Stale-claim reaper poke endpoint. The Fly worker hits this on an interval to
// requeue worker job rows (pb_upload_jobs + iv_post_jobs) that a crashed/restarted
// worker left stranded in status='claimed' forever — see reapStaleClaims().
//
// Vercel Hobby caps crons at once/day, so this is a poke-able route rather than a
// new Vercel cron (the worker drives it; worker-poker wiring in worker/scripts/
// is a follow-up). The pb-upload/next claim ALSO calls reapStaleClaims()
// opportunistically, so this is a belt-and-suspenders cadence, not the only path.
//
// Auth: Bearer ${WORKER_SHARED_SECRET} (preferred) or ${CRON_SECRET}.

import { NextResponse } from "next/server";
import { reapStaleClaims } from "@/lib/labs/reap-stale-claims";

export const dynamic = "force-dynamic";

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.WORKER_SHARED_SECRET;
  if (!cronSecret && !workerSecret) {
    return NextResponse.json({ ok: false, error: "no auth secret configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  const ok =
    (workerSecret && auth === `Bearer ${workerSecret}`) ||
    (cronSecret && auth === `Bearer ${cronSecret}`);
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const result = await reapStaleClaims();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

// POST is the worker's natural verb for queue ops (matches pb-upload/next,
// iv-post/*). GET is allowed too so a Vercel cron / curl can poke it.
export async function POST(request: Request) {
  return run(request);
}
export async function GET(request: Request) {
  return run(request);
}
