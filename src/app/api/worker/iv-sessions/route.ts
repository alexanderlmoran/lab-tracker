// Zenoti IV → iv_sessions sync endpoint.
//
// The worker (worker/scripts/zenoti-iv-sync.ts) calls this after pulling a day's
// "IV -" appointments out of Zenoti via fetchZenotiIvAppointments. We UPSERT
// iv_sessions by zenoti_appointment_id so re-runs are idempotent.
//
// IMPORTANT: the upsert payload contains ONLY the Zenoti-derived + classification
// columns — never chart / charting_status / pb_note_id / pc_*. PostgREST
// merge-duplicates updates only the provided columns, so re-syncing an
// already-charted session refreshes its appointment data WITHOUT wiping the
// staff's vitals, note status, or posted note. (Same reason the cases endpoint
// is careful about which columns it touches.)
//
// Auth: Bearer ${WORKER_SHARED_SECRET}, identical to /api/worker/cases.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const IvAppointmentInput = z.object({
  zenotiAppointmentId: z.string().min(1),
  zenotiGuestId: z.string().optional().default(""),
  patientFirstName: z.string().optional().default(""),
  patientLastName: z.string().optional().default(""),
  patientFullName: z.string().optional().default(""),
  patientEmail: z.string().nullable().optional(),
  patientPhone: z.string().nullable().optional(),
  serviceName: z.string().min(1),
  serviceId: z.string().optional().default(""),
  kind: z.enum(["standard", "addon", "pc", "custom", "ebo"]),
  isAddOn: z.boolean().optional().default(false),
  weber: z.boolean().optional().default(false),
  templateHint: z.string().nullable().optional(),
  startAt: z.string().nullable().optional(),
  collectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().nullable().optional(),
  therapistName: z.string().nullable().optional(),
  cancelled: z.boolean().optional().default(false),
});

const Body = z.object({
  appointments: z.array(IvAppointmentInput),
  /** Fallback session date for appts whose startAt was unparseable. The worker
   *  syncs per-day, so it always knows the date. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "WORKER_SHARED_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
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

  // Synced columns ONLY — preserves charting state on conflict (see header).
  const rows = parsed.appointments.map((a) => ({
    zenoti_appointment_id: a.zenotiAppointmentId,
    zenoti_guest_id: a.zenotiGuestId || null,
    patient_first_name: a.patientFirstName || null,
    patient_last_name: a.patientLastName || null,
    patient_full_name: a.patientFullName || null,
    patient_email: a.patientEmail ?? null,
    patient_phone: a.patientPhone ?? null,
    service_name: a.serviceName,
    service_id: a.serviceId || null,
    therapist_name: a.therapistName ?? null,
    zenoti_note: a.note ?? null,
    session_date: a.collectionDate ?? parsed.date,
    start_at: a.startAt ?? null,
    cancelled: a.cancelled,
    kind: a.kind,
    is_add_on: a.isAddOn,
    weber: a.weber,
    template_hint: a.templateHint ?? null,
  }));

  let upserted = 0;
  if (rows.length > 0) {
    const { data, error } = await db
      .from("iv_sessions")
      .upsert(rows, { onConflict: "zenoti_appointment_id" })
      .select("id");
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    upserted = data?.length ?? 0;
  }

  // Heartbeat so the Health tab can see the IV sync is alive (same pattern as
  // the zenoti-sync heartbeat in /api/worker/cases).
  await db
    .from("lab_scraper_status")
    .upsert(
      {
        portal_key: "zenoti-iv-sync",
        last_check_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        consecutive_failures: 0,
        last_error: null,
      },
      { onConflict: "portal_key" },
    )
    .then(({ error }) => {
      if (error) console.warn(`[iv-sessions] heartbeat failed: ${error.message}`);
    });

  return NextResponse.json({
    ok: true,
    received: parsed.appointments.length,
    upserted,
    date: parsed.date,
  });
}
