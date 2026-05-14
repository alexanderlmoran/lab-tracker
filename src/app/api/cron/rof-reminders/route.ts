// Daily RoF-scheduling reminder cron. Auth mirrors /api/cron/refresh-tracking.

import { NextResponse } from "next/server";
import { runRofReminders } from "@/lib/email/digests";

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

  const summary = await runRofReminders();
  return NextResponse.json({ ...summary, at: new Date().toISOString() });
}
