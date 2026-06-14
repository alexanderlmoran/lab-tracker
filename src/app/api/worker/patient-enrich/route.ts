// Zenoti guest profile -> patients_seed enrichment endpoint.
//
// The worker (worker/scripts/zenoti-enrich.ts) pulls a day's appointments, looks
// up each unique guest's full profile via the Zenoti V1 API (DOB, sex, address —
// the fields the appointment payload lacks), and POSTs them here. We upsert them
// into patients_seed, the identity cache that req-form resolve and the IV match
// scorer already read for DOB. This is the "1 feeds the rest" landing: Zenoti is
// the source of truth, patients_seed is the tracker's copy, PB is filled from it.
//
// Safety: only NON-NULL incoming fields are written, so a Zenoti row with a blank
// address never wipes an existing value. email is the conflict key — rows without
// one are skipped (patients_seed.email is NOT NULL UNIQUE, lowercased).
//
// Auth: Bearer ${WORKER_SHARED_SECRET}, identical to /api/worker/iv-sessions.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const PatientInput = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().nullable().optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sex: z.enum(["M", "F"]).nullable().optional(),
  address: z.string().nullable().optional(),
});

const Body = z.object({ patients: z.array(PatientInput) });

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "WORKER_SHARED_SECRET not configured" },
      { status: 500 },
    );
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Invalid body: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of parsed.patients) {
    const email = p.email.trim().toLowerCase();
    if (!email) {
      skipped += 1;
      continue;
    }
    // Build the row from required keys + only the non-null enriched fields, so
    // PostgREST's merge-duplicates update touches just the columns we actually
    // have — a blank Zenoti field is omitted and the existing value survives.
    const row: Record<string, unknown> = {
      patient_name: p.name.trim(),
      email,
      source: "zenoti",
    };
    if (p.phone != null) row.phone = p.phone;
    if (p.dob != null) row.dob = p.dob;
    if (p.sex != null) row.sex = p.sex;
    if (p.address != null) row.address = p.address;

    // patients_seed is keyed on the COMPOSITE (email, patient_name) — families
    // share an email but each member is a distinct row (see the 20260519
    // composite-key migration). Conflict on both so a guest's DOB/sex/address
    // updates only their row, never a sibling's. Unmatched (email, name) inserts.
    const { error } = await db
      .from("patients_seed")
      .upsert(row, { onConflict: "email,patient_name" });
    if (error) {
      errors.push(`${email}: ${error.message}`);
      skipped += 1;
    } else {
      upserted += 1;
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    received: parsed.patients.length,
    upserted,
    skipped,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
