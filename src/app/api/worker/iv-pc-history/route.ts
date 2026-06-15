// PC infusion-series enrichment bridge (worker has no DB access, so it goes
// through this API). The worker has the PB session; this has the DB.
//   GET  → pending PC sessions that still need an infusion # (id + identity), so
//          the worker can look up the patient's last PC note in PB.
//   POST → set pc_infusion_number (= last + 1) and pc_vial_count for the resolved
//          sessions. Only fills where still NULL (never clobbers).
// Auth: Bearer ${WORKER_SHARED_SECRET}.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const expected = process.env.WORKER_SHARED_SECRET;
  return !!expected && (req.headers.get("authorization") ?? "") === `Bearer ${expected}`;
}

export async function GET(req: Request) {
  if (!process.env.WORKER_SHARED_SECRET) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if (!authed(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("iv_sessions")
    .select("id, patient_full_name, patient_first_name, patient_last_name, patient_email, patient_phone")
    .eq("kind", "pc")
    .eq("charting_status", "pending")
    .is("pc_infusion_number", null)
    .limit(50);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}

export async function POST(req: Request) {
  if (!process.env.WORKER_SHARED_SECRET) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if (!authed(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { updates?: Array<{ sessionId: string; infusionNumber: number; vialCount: string | null }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
  const db = getSupabaseAdmin();
  let updated = 0;
  for (const u of body.updates ?? []) {
    if (!u.sessionId || typeof u.infusionNumber !== "number") continue;
    const { error } = await db
      .from("iv_sessions")
      .update({ pc_infusion_number: u.infusionNumber, pc_vial_count: u.vialCount })
      .eq("id", u.sessionId)
      .is("pc_infusion_number", null); // only fill — never clobber a value already set
    if (!error) updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
