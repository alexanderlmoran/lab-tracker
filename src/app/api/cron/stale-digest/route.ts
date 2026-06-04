// Daily stale-case digest cron. Auth mirrors /api/cron/refresh-tracking:
// Vercel sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.

import { NextResponse } from "next/server";
import { runStaleDigest } from "@/lib/email/digests";
import { archiveStaleProtocolReceived } from "@/lib/labs/auto-archive";

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

  const summary = await runStaleDigest({});
  // Tidy: archive protocol-received cases idle 21+ days (→ /labs/archived).
  const autoArchived = await archiveStaleProtocolReceived({ olderThanDays: 21 }).catch(
    (e) => ({ archived: 0, error: e instanceof Error ? e.message : String(e) }),
  );
  return NextResponse.json({ ...summary, autoArchived, at: new Date().toISOString() });
}
