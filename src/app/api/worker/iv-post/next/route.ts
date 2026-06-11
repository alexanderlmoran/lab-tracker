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

/** Normalize a template_hint for join-key matching: straighten curly quotes,
 *  collapse whitespace, lowercase. Keeps "Myers’ Cocktail" == "Myers' Cocktail". */
function normalizeTemplateHint(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

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
      "id, patient_full_name, patient_first_name, patient_last_name, patient_email, service_name, kind, template_hint, session_date, chart, pc_infusion_number, pc_vial_count, pb_note_id, pb_client_record_id",
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

  // Resolve the template scaffold reference note. template_hint is a free string
  // that drifts on apostrophes / whitespace / case (Zenoti's curly ’ vs a seeded
  // straight '), so match on a NORMALIZED form rather than exact eq — otherwise
  // e.g. "Myers’ Cocktail" never finds "Myers' Cocktail" and the post holds.
  let referenceNoteId: string | null = null;
  const { data: refs } = await db.from("iv_template_refs").select("template_hint, reference_note_id");
  const allRefs = refs ?? [];
  const normHint = normalizeTemplateHint(s.template_hint);
  if (normHint) {
    referenceNoteId = allRefs.find((r) => normalizeTemplateHint(r.template_hint) === normHint)?.reference_note_id ?? null;
  }
  if (!referenceNoteId) {
    // Fallback: the base IV template for ad-hoc / custom / chelation / unmatched
    // services (components are form-driven, so it fits any IV). Keeps a note from
    // ever being un-postable. Seed iv_template_refs.template_hint = '__base_iv__'.
    referenceNoteId = allRefs.find((r) => r.template_hint === "__base_iv__")?.reference_note_id ?? null;
  }
  const ref = referenceNoteId ? { reference_note_id: referenceNoteId } : null;

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
      // Set once this session was posted — drives update-vs-create on re-post.
      pbNoteId: s.pb_note_id,
      pbClientRecordId: s.pb_client_record_id,
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
