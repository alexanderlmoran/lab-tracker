// Capture a PB note onto its tracker session (PB→tracker sync). The worker found
// that this session was already charted in PB (by hand / not by us), so stamp the
// note onto the session: charting_status='posted' + pb_note_id so the board shows
// it as charted and the sweep stops trying to (re-)post it. Also drop any pending
// post job for the session so the drain can't create a DUPLICATE note.
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  sessionId: z.string().uuid(),
  pbNoteId: z.string().min(1),
  pbClientRecordId: z.string().min(1),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let p: z.infer<typeof Body>;
  try { p = Body.parse(await request.json()); }
  catch (e) { return NextResponse.json({ ok: false, error: `Invalid body: ${e instanceof Error ? e.message : "?"}` }, { status: 400 }); }

  const db = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Drop any in-flight/held/done post job FIRST — if the status flips to posted
  // but a queued job lingers, the drain posts a duplicate note. Abort on failure.
  const { error: delErr } = await db.from("iv_post_jobs").delete().eq("session_id", p.sessionId);
  if (delErr) return NextResponse.json({ ok: false, error: `couldn't drop post job (not capturing, to avoid a duplicate): ${delErr.message}` }, { status: 500 });

  // Stamp the PB note onto the session, but only if it's still uncaptured — never
  // clobber a note we actually posted (guard on pb_note_id IS NULL).
  const { data: updated, error } = await db
    .from("iv_sessions")
    .update({ charting_status: "posted", pb_note_id: p.pbNoteId, pb_client_record_id: p.pbClientRecordId, posted_at: now, create_pb_account: false })
    .eq("id", p.sessionId)
    .is("pb_note_id", null)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, captured: !!updated });
}
