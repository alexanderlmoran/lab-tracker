// Daily system-integrity audit cron. Emails DOB / accession gaps (only when
// there are any) to the pending-digest recipients. Auth: Bearer CRON_SECRET.

import { NextResponse } from "next/server";
import { runIntegrityAudit } from "@/lib/email/digests";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runIntegrityAudit();
  return NextResponse.json({ ...summary, at: new Date().toISOString() });
}
