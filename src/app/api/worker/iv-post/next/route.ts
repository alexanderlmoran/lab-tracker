// IV post-job claim endpoint. The worker polls this; we atomically claim the
// oldest queued job and hydrate everything it needs to grade + post:
//   - the session + its chart (the staff-entered overlay)
//   - the patient identity enriched from patients_seed (DOB lives there, not in
//     the Zenoti appt) so the worker can score name+DOB+email
//   - the reference note id for the template scaffold (iv_template_refs)
//
// Auth: Bearer ${WORKER_SHARED_SECRET}. Returns 204 when the queue is empty.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();

  // Two-step atomic claim (same pattern as pb-upload/next): find oldest queued,
  // then UPDATE guarded by status='queued' so a concurrent poller can't double-claim.
  const { data: candidate } = await db
    .from("iv_post_jobs")
    .select("id, session_id, attempts")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return new NextResponse(null, { status: 204 });

  const { data: claimed } = await db
    .from("iv_post_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString(), attempts: candidate.attempts + 1 })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("id, session_id")
    .maybeSingle();
  if (!claimed) return new NextResponse(null, { status: 204 }); // lost the race

  // Hydrate the session.
  const { data: s, error: sErr } = await db
    .from("iv_sessions")
    .select(
      "id, patient_full_name, patient_first_name, patient_last_name, patient_email, service_name, kind, template_hint, session_date, chart, pc_infusion_number, pc_vial_count",
    )
    .eq("id", claimed.session_id)
    .maybeSingle();
  if (sErr || !s) {
    await db.from("iv_post_jobs").update({ status: "failed", last_error: "session not found", finished_at: new Date().toISOString() }).eq("id", claimed.id);
    return new NextResponse(null, { status: 204 });
  }

  // Enrich identity from patients_seed (DOB/email/phone keyed by name or email).
  let dob: string | null = null;
  let seedEmail: string | null = null;
  const nm = (s.patient_full_name ?? "").trim();
  const em = (s.patient_email ?? "").trim();
  if (nm || em) {
    const ors: string[] = [];
    if (nm) ors.push(`patient_name.ilike.${nm}`);
    if (em) ors.push(`email.ilike.${em}`);
    const { data: seed } = await db
      .from("patients_seed")
      .select("dob, email")
      .or(ors.join(","))
      .limit(1)
      .maybeSingle();
    if (seed) {
      dob = (seed.dob as string | null) ?? null;
      seedEmail = (seed.email as string | null) ?? null;
    }
  }

  // Resolve the template scaffold reference note.
  const { data: ref } = await db
    .from("iv_template_refs")
    .select("reference_note_id")
    .eq("template_hint", s.template_hint ?? "")
    .maybeSingle();

  return NextResponse.json({
    job: { id: claimed.id, sessionId: s.id },
    session: {
      id: s.id,
      serviceName: s.service_name,
      kind: s.kind,
      templateHint: s.template_hint,
      sessionDate: s.session_date,
      chart: s.chart ?? {},
      pc: { infusionNumber: s.pc_infusion_number, vialCount: s.pc_vial_count },
    },
    identity: {
      fullName: s.patient_full_name,
      firstName: s.patient_first_name,
      lastName: s.patient_last_name,
      email: em || seedEmail,
      dob,
    },
    referenceNoteId: ref?.reference_note_id ?? null,
  });
}
