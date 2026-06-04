// Vercel cron entry point. Schedule lives in /vercel.json (top-level).
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` for cron-
// triggered invocations; we reject any other caller. CRON_SECRET must be
// set in Vercel project env vars.

import { NextResponse } from "next/server";
import { refreshTrackingForActiveCasesCore } from "@/lib/tracking/refresh-core";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Accept either the Vercel cron secret OR the worker's shared secret — the
  // Fly worker drives this on a couple-hours cadence (Vercel Hobby caps crons
  // at once/day), authing with the secret it already has. See docs/PLAYBOOK.md.
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.WORKER_SHARED_SECRET;
  if (!cronSecret && !workerSecret) {
    return NextResponse.json(
      { ok: false, error: "no auth secret configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const ok =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (workerSecret && auth === `Bearer ${workerSecret}`);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Allow up to 1000 lookups per cron tick — much higher than the manual
  // button's 300 cap, since cron runtime is not interactive.
  const result = await refreshTrackingForActiveCasesCore({
    actor: "cron",
    limit: 1000,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    polled: result.polled,
    updated: result.updated,
    errors: result.errors,
    at: new Date().toISOString(),
  });
}
