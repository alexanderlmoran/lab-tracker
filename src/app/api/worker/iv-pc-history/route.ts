// PC infusion-series SEED bridge. The infusion number now lives in our local
// ledger (iv_infusion_series) and is assigned at post time — but each patient's
// ledger must first be BOOTSTRAPPED from PracticeBetter ONCE (their existing
// "#29" history). The worker has the PB session; this has the DB.
//   GET  → PC patients (unique by zenoti_guest_id) that still have NO seeded
//          ledger row, with identity, so the worker can look up their last PB PC
//          note. Once a patient is seeded they NEVER appear here again — that's
//          the "stop going to PB for history" goal: one read per patient, ever.
//   POST → seed iv_infusion_series rows (last_number = their last PB "#N", or 0
//          if PB has none). Only seeds where not already seeded — never clobbers
//          a locally-incremented count.
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

  // Patients of UNPOSTED PC sessions (guest id is the stable per-patient key).
  // Scoping to pb_note_id IS NULL bounds this to patients who actually need a
  // number now — so seeded/posted history can't crowd out new patients in the
  // row window (a patient with many past PC notes would otherwise starve the cap).
  const { data: pcs, error } = await db
    .from("iv_sessions")
    .select("zenoti_guest_id, patient_full_name, patient_first_name, patient_last_name, patient_email, patient_phone")
    .eq("kind", "pc")
    .is("pb_note_id", null)
    .not("zenoti_guest_id", "is", null)
    .order("session_date", { ascending: false })
    .limit(1000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Guests we've already bootstrapped — skip (one PB read per patient, ever).
  const { data: seeded } = await db.from("iv_infusion_series").select("zenoti_guest_id").eq("series", "pc").eq("seeded", true);
  const seededSet = new Set((seeded ?? []).map((r) => r.zenoti_guest_id as string));

  const byGuest = new Map<string, (typeof pcs)[number]>();
  for (const s of pcs ?? []) {
    const g = (s.zenoti_guest_id ?? "").trim();
    if (!g || seededSet.has(g) || byGuest.has(g)) continue;
    byGuest.set(g, s);
  }
  const patients = [...byGuest.values()].slice(0, 50).map((s) => ({
    zenotiGuestId: s.zenoti_guest_id,
    patientFullName: s.patient_full_name,
    patientFirstName: s.patient_first_name,
    patientLastName: s.patient_last_name,
    patientEmail: s.patient_email,
    patientPhone: s.patient_phone,
  }));
  return NextResponse.json({ patients });
}

export async function POST(req: Request) {
  if (!process.env.WORKER_SHARED_SECRET) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if (!authed(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { seeds?: Array<{ zenotiGuestId: string; lastNumber: number; lastVialCount: string | null; patientFullName?: string | null }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
  const db = getSupabaseAdmin();
  let seeded = 0;
  for (const u of body.seeds ?? []) {
    const guest = (u.zenotiGuestId ?? "").trim();
    if (!guest || typeof u.lastNumber !== "number") continue;
    // Only seed an un-seeded guest — never clobber a count we've been incrementing.
    const { data: existing } = await db
      .from("iv_infusion_series")
      .select("seeded")
      .eq("zenoti_guest_id", guest)
      .eq("series", "pc")
      .maybeSingle();
    if (existing?.seeded) continue;
    const { error } = await db.from("iv_infusion_series").upsert(
      {
        zenoti_guest_id: guest,
        series: "pc",
        last_number: u.lastNumber,
        last_vial_count: u.lastVialCount,
        patient_full_name: u.patientFullName ?? null,
        seeded: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "zenoti_guest_id,series" },
    );
    if (!error) seeded++;
  }
  return NextResponse.json({ ok: true, seeded });
}
