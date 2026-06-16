// Reliability watchdog cron. Reads the worker heartbeats (lab_scraper_status)
// and emails an alert if any watched loop has gone quiet or is failing — so a
// silently-stopped automation (the "Synced 8d ago" outage) is caught and pushed
// to staff instead of discovered by a missing result. Runs on Vercel cron AND
// is pokeable by the worker (either secret) for more frequent checks.
//
// Schedule lives in /vercel.json. Auth: Bearer ${CRON_SECRET} or ${WORKER_SHARED_SECRET}.

import { NextResponse } from "next/server";
import { runHeartbeatWatch } from "@/lib/email/digests";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.WORKER_SHARED_SECRET;
  if (!cronSecret && !workerSecret) {
    return NextResponse.json({ ok: false, error: "no auth secret configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  const ok = (cronSecret && auth === `Bearer ${cronSecret}`) || (workerSecret && auth === `Bearer ${workerSecret}`);
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const result = await runHeartbeatWatch();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
