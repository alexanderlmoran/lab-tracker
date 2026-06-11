// Worker-triggered Gmail inbox sync. Vercel Hobby crons cap at once/day, so
// the Fly worker's gmailsync loop POSTs here every couple of minutes — same
// pattern as the scrape/tracking loops. Bearer-authed with the shared secret.

import { NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/gmail/sync";

export const dynamic = "force-dynamic";
// Sync fetches up to ~75 messages + attachments + Claude parses; give it room
// beyond the default function timeout.
export const maxDuration = 300;

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await syncGmailInbox();
    return NextResponse.json({
      ok: true,
      processed: r.processed,
      skipped: r.skipped,
      errors: r.errors,
    });
  } catch (err) {
    // "Gmail not connected" lands here — a 200 with ok:false keeps the loop
    // calm (it logs and retries next tick) instead of crash-looping.
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "sync failed",
    });
  }
}
