// Email queue sweeper poke endpoint. Flips email_logs rows wedged at
// status='queued' past the stuck threshold to 'failed' (with a reason) — see
// sweepStuckEmails(). Does NOT auto-resend (the send isn't idempotent); flag +
// count is the safe default, and the counts feed the heartbeat-watch digest.
//
// runHeartbeatWatch() already runs this sweep on its daily Vercel cron; this
// route lets the Fly worker poke it more often (Vercel Hobby caps crons at
// once/day). worker-poker wiring in worker/scripts/ is a follow-up.
//
// Auth: Bearer ${WORKER_SHARED_SECRET} (preferred) or ${CRON_SECRET}.

import { NextResponse } from "next/server";
import { sweepStuckEmails } from "@/lib/email/digests";

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

  const result = await sweepStuckEmails();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(request: Request) {
  return run(request);
}
export async function GET(request: Request) {
  return run(request);
}
