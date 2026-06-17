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

/** Assign a PC session its infusion number from our LOCAL ledger
 *  (iv_infusion_series) — the authoritative count, so we never parse PB note
 *  titles or race the enrich pass. Returns { number, vialCount } or null.
 *
 *  Applies only to kind='pc' with a guest id, no number yet, and not a re-post.
 *  Reads the SEEDED ledger row and atomically increments it (guarded update, so
 *  two concurrent claims for one patient can't take the same number). If the row
 *  isn't seeded yet (the worker hasn't done its one-time PB bootstrap for this
 *  patient), returns null → the drain HOLDS the post instead of posting it
 *  unnumbered (the bug this fixes). The seed lands within a loop cycle and the
 *  next sweep re-posts it numbered.
 *
 *  Persists the number onto iv_sessions immediately so a re-post reuses it (never
 *  a second increment) and the board shows it. */
async function assignPcInfusionNumber(
  db: ReturnType<typeof getSupabaseAdmin>,
  s: {
    id: string;
    zenoti_guest_id: string | null;
    kind: string;
    chart: unknown;
    pc_infusion_number: number | null;
    pc_vial_count: string | null;
    pb_note_id: string | null;
  },
): Promise<{ number: number; vialCount: string | null } | null> {
  const guest = (s.zenoti_guest_id ?? "").trim();
  if (s.kind !== "pc" || !guest || s.pc_infusion_number != null || s.pb_note_id) return null;

  const chart = (s.chart as { pc?: { infusionNumber?: number | null; vialCount?: string } } | null) ?? null;
  // The chart's per-visit vial count wins; the ledger's last value is a fallback.
  const chartVials = (chart?.pc?.vialCount ?? "").trim();

  // A staff-entered number on the form is AUTHORITATIVE — honor it AND sync the
  // ledger up to it (create the row if absent), so the override propagates to the
  // patient's future visits and the ledger never disagrees with what posted.
  const staffNum = chart?.pc?.infusionNumber;
  if (typeof staffNum === "number" && Number.isInteger(staffNum) && staffNum > 0) {
    const vialCount = chartVials || s.pc_vial_count || null;
    await db.from("iv_infusion_series").upsert(
      { zenoti_guest_id: guest, series: "pc", last_number: staffNum, last_vial_count: vialCount, seeded: true, updated_at: new Date().toISOString() },
      { onConflict: "zenoti_guest_id,series", ignoreDuplicates: false },
    );
    const { data: persisted } = await db.from("iv_sessions").update({ pc_infusion_number: staffNum, pc_vial_count: vialCount }).eq("id", s.id).is("pc_infusion_number", null).select("id").maybeSingle();
    return persisted ? { number: staffNum, vialCount } : null;
  }

  // Auto-mint from a SEEDED ledger (atomic guarded increment).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: ledger } = await db
      .from("iv_infusion_series")
      .select("last_number, last_vial_count")
      .eq("zenoti_guest_id", guest)
      .eq("series", "pc")
      .eq("seeded", true)
      .maybeSingle();
    if (!ledger) return null; // not bootstrapped from PB yet → caller holds
    const current = (ledger.last_number as number | null) ?? 0;
    const next = current + 1;
    const { data: bumped } = await db
      .from("iv_infusion_series")
      .update({ last_number: next, updated_at: new Date().toISOString() })
      .eq("zenoti_guest_id", guest)
      .eq("series", "pc")
      .eq("last_number", current) // optimistic guard — fails if someone else bumped it
      .select("last_number")
      .maybeSingle();
    if (!bumped) continue; // lost the race → re-read and retry
    const vialCount = chartVials || s.pc_vial_count || (ledger.last_vial_count as string | null) || null;
    // Persist guarded by IS NULL so a number is recorded exactly once. If the
    // write fails or matched no row, ROLL THE LEDGER BACK so the number isn't
    // burned (which would otherwise gap the sequence or double-increment on the
    // next sweep), then bail → the drain holds and retries cleanly.
    const { data: persisted } = await db
      .from("iv_sessions")
      .update({ pc_infusion_number: next, pc_vial_count: vialCount })
      .eq("id", s.id)
      .is("pc_infusion_number", null)
      .select("id")
      .maybeSingle();
    if (!persisted) {
      await db.from("iv_infusion_series").update({ last_number: current }).eq("zenoti_guest_id", guest).eq("series", "pc").eq("last_number", next);
      return null;
    }
    return { number: next, vialCount };
  }
  return null; // extreme contention — hold this round, retry next sweep
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
      "id, zenoti_guest_id, patient_full_name, patient_first_name, patient_last_name, patient_email, patient_phone, service_name, kind, template_hint, session_date, chart, pc_infusion_number, pc_vial_count, pb_note_id, pb_client_record_id, create_pb_account",
    )
    .eq("id", claimed.session_id)
    .maybeSingle();
  if (sErr || !s) {
    await db.from("iv_post_jobs").update({ status: "failed", last_error: "session not found", finished_at: new Date().toISOString() }).eq("id", claimed.id);
    return new NextResponse(null, { status: 204 });
  }

  // Assign the PC infusion number from our local ledger (authoritative count) —
  // never re-derived from PB titles, never racing the enrich pass. null means the
  // patient isn't bootstrapped from PB yet → the drain holds the post (it won't
  // post unnumbered).
  const assignedPc = await assignPcInfusionNumber(db, s);

  // Enrich identity from patients_seed (DOB/email/phone keyed by name or email).
  let dob: string | null = null;
  let seedEmail: string | null = null;
  let seedPhone: string | null = null;
  const nm = (s.patient_full_name ?? "").trim();
  const em = (s.patient_email ?? "").trim();
  if (nm || em) {
    const ors: string[] = [];
    if (nm) ors.push(`patient_name.ilike.${nm}`);
    if (em) ors.push(`email.ilike.${em}`);
    const { data: seed } = await db
      .from("patients_seed")
      .select("dob, email, phone")
      .or(ors.join(","))
      .limit(1)
      .maybeSingle();
    if (seed) {
      dob = (seed.dob as string | null) ?? null;
      seedEmail = (seed.email as string | null) ?? null;
      seedPhone = (seed.phone as string | null) ?? null;
    }
  }

  // Resolve the template scaffold reference note. template_hint is a free string
  // that drifts on apostrophes / whitespace / case (Zenoti's curly ’ vs a seeded
  // straight '), so match on a NORMALIZED form rather than exact eq — otherwise
  // e.g. "Myers’ Cocktail" never finds "Myers' Cocktail" and the post holds.
  let referenceNoteId: string | null = null;
  let templateMatched = false; // true = matched this service's own template; false = base-IV fallback
  const { data: refs } = await db.from("iv_template_refs").select("template_hint, reference_note_id");
  const allRefs = refs ?? [];
  const normHint = normalizeTemplateHint(s.template_hint);
  if (normHint) {
    referenceNoteId = allRefs.find((r) => normalizeTemplateHint(r.template_hint) === normHint)?.reference_note_id ?? null;
    if (referenceNoteId) templateMatched = true;
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
      pc: {
        infusionNumber: assignedPc?.number ?? s.pc_infusion_number,
        vialCount: assignedPc?.vialCount ?? s.pc_vial_count,
      },
      // Set once this session was posted — drives update-vs-create on re-post.
      pbNoteId: s.pb_note_id,
      pbClientRecordId: s.pb_client_record_id,
      // Staff clicked "Create PB account & post" — the drain creates the PB
      // record (via createPbPatient) IF it still finds no candidate.
      createPbAccount: !!s.create_pb_account,
    },
    identity: {
      fullName: s.patient_full_name,
      firstName: s.patient_first_name,
      lastName: s.patient_last_name,
      email: em || seedEmail,
      dob,
      phone: (s.patient_phone ?? "").trim() || seedPhone,
    },
    referenceNoteId: ref?.reference_note_id ?? null,
    templateMatched,
  });
}
