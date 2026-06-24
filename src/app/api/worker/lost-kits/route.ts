// Lost-kit scan poke endpoint. Returns active sample-sent cases whose FedEx
// shipment went returned/exception with no accession and no result on file —
// kits that almost certainly need re-ordering, distinct from generic "overdue".
// See scanLostKits().
//
// runHeartbeatWatch() already folds these into its daily Vercel-cron digest;
// this route lets the Fly worker poke a scan on demand / more often (Vercel
// Hobby caps crons at once/day). It's read-only — it surfaces the list, it does
// not mutate cases. worker-poker wiring in worker/scripts/ is a follow-up.
//
// Auth: Bearer ${WORKER_SHARED_SECRET} (preferred) or ${CRON_SECRET}.

import { NextResponse } from "next/server";
import { scanLostKits } from "@/lib/email/digests";

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

  const result = await scanLostKits();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(request: Request) {
  return run(request);
}
export async function GET(request: Request) {
  return run(request);
}
