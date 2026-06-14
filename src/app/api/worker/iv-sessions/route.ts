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
import { defaultIvChart } from "@/app/labs/iv/chart-util";

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
  /** Every appointment id Zenoti currently returns for `date`. When present, any
   *  iv_sessions row on this date whose id is absent is reconciled away (stale:
   *  rescheduled → new id, cancelled, or deleted upstream). Omit to skip the
   *  reconcile pass (old zenoti-iv-sync.ts does). Mirrors the lab /cases census. */
  census: z.array(z.string()).optional(),
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

  // Seed a default chart for still-empty sessions so the form shows editable
  // placeholder values and the posted note is never blank. The chart column is
  // `not null default '{}'`, so "uncharted" means an EMPTY object (never null) —
  // we read the current charts and fill only the empty ones, never overwriting a
  // staff chart (the upsert above deliberately omits chart — see header). EBOO
  // (charted by hand in PB), add-ons (attach to the base note), and cancelled
  // appts are left blank. dob is unknown at sync → vitals use age-neutral ranges.
  const seedable = rows.filter((r) => !r.cancelled && r.kind !== "ebo" && !r.is_add_on);
  if (seedable.length > 0) {
    const apptIds = seedable.map((r) => r.zenoti_appointment_id);
    const { data: existing } = await db
      .from("iv_sessions")
      .select("id, zenoti_appointment_id, chart")
      .in("zenoti_appointment_id", apptIds);
    const byAppt = new Map((existing ?? []).map((e) => [e.zenoti_appointment_id, e]));
    for (const r of seedable) {
      const row = byAppt.get(r.zenoti_appointment_id);
      if (!row) continue;
      const chart = row.chart as Record<string, unknown> | null;
      if (chart && Object.keys(chart).length > 0) continue; // already charted/seeded
      await db
        .from("iv_sessions")
        .update({ chart: defaultIvChart({ kind: r.kind, serviceName: r.service_name }) })
        .eq("id", row.id);
    }
  }

  // Reconcile away stale sessions: any iv_sessions row on this date whose
  // appointment id Zenoti no longer returns (rescheduled → new id, cancelled, or
  // hard-deleted upstream) is obsolete and was the source of the IV-board dupes
  // (an upsert-only sync never removed the superseded rows). Same census pass the
  // lab /cases route uses. NEVER delete a POSTED session (pb_note_id set) — that
  // would orphan its PB note; a posted note outlives the appointment.
  let reconciledDeleted = 0;
  if (parsed.census) {
    const censusSet = new Set(parsed.census);
    const { data: onDate } = await db
      .from("iv_sessions")
      .select("id, zenoti_appointment_id, pb_note_id")
      .eq("session_date", parsed.date);
    const staleIds = (onDate ?? [])
      .filter(
        (r) => !censusSet.has(r.zenoti_appointment_id as string) && r.pb_note_id == null,
      )
      .map((r) => r.id as string);
    if (staleIds.length > 0) {
      // iv_post_jobs FKs session_id with no ON DELETE CASCADE — clear children first.
      await db.from("iv_post_jobs").delete().in("session_id", staleIds);
      const { data: del } = await db
        .from("iv_sessions")
        .delete()
        .in("id", staleIds)
        .select("id");
      reconciledDeleted = del?.length ?? 0;
    }
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
    reconciledDeleted,
    date: parsed.date,
  });
}
