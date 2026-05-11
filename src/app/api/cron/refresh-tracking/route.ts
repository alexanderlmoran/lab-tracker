// Vercel cron entry point. Schedule lives in /vercel.json (top-level).
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` for cron-
// triggered invocations; we reject any other caller. CRON_SECRET must be
// set in Vercel project env vars.

import { NextResponse } from "next/server";
import { refreshTrackingForActiveCasesCore } from "@/lib/tracking/refresh-core";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
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
