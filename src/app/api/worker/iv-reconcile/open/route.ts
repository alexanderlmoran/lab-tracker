// Open IV sessions to reconcile against PB (the PB→tracker sync source list).
// Returns recent sessions that are NOT yet captured — pending/ready, no pb_note_id,
// not skipped — including EBOO/EBO2 (the tracker can't post them, but they ARE
// charted in PB by hand, so they must sync back). Add-ons are excluded (they merge
// onto the base note, no note of their own). The worker matches each patient + looks
// for a same-day PB note and posts back to /iv-reconcile/capture.
//
// Auth: Bearer ${WORKER_SHARED_SECRET}. Query: ?days=N (lookback, default 7),
// ?max=N (cap, default 60).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const days = Math.max(0, Math.min(30, Number(url.searchParams.get("days") ?? "7")));
  const max = Math.max(1, Math.min(200, Number(url.searchParams.get("max") ?? "60")));

  const from = new Date();
  from.setUTCDate(from.getUTCDate() - days);
  const fromStr = from.toISOString().slice(0, 10);

  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("iv_sessions")
    .select(
      "id, service_name, session_date, kind, template_hint, patient_full_name, patient_first_name, patient_last_name, patient_email, patient_phone, pb_client_record_id, pc_infusion_number, pc_vial_count",
    )
    .eq("cancelled", false)
    .eq("is_add_on", false)
    .neq("kind", "addon")
    .is("pb_note_id", null) // not yet captured
    .not("charting_status", "in", "(posted,skipped)") // not already synced / dismissed
    .gte("session_date", fromStr)
    .order("session_date", { ascending: false })
    .limit(max);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const sessions = (data ?? []).map((s) => ({
    sessionId: s.id as string,
    serviceName: (s.service_name as string) ?? "",
    sessionDate: (s.session_date as string) ?? "",
    kind: (s.kind as string) ?? "standard",
    templateHint: (s.template_hint as string | null) ?? null,
    pbClientRecordId: (s.pb_client_record_id as string | null) ?? null,
    identity: {
      fullName: (s.patient_full_name as string | null) ?? null,
      firstName: (s.patient_first_name as string | null) ?? null,
      lastName: (s.patient_last_name as string | null) ?? null,
      email: (s.patient_email as string | null) ?? null,
      phone: (s.patient_phone as string | null) ?? null,
      dob: null, // email/phone anchor the confident match; DOB only corroborates
    },
    pc: {
      infusionNumber: (s.pc_infusion_number as number | null) ?? null,
      vialCount: (s.pc_vial_count as string | null) ?? undefined,
    },
  }));

  return NextResponse.json({ ok: true, window: { from: fromStr }, count: sessions.length, sessions });
}
