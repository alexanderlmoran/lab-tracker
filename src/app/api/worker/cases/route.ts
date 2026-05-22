// Zenoti → tracker sync endpoint.
//
// The worker calls this after pulling today's lab appointments out of Zenoti.
// We UPSERT lab_cases by zenoti_appointment_id so re-runs are idempotent and
// the same appointment can never produce two cases.
//
// Auth: Bearer ${WORKER_SHARED_SECRET}. Same shared secret used by the other
// /api/worker/* endpoints called from worker/src/tracker-client.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const LabAppointmentInput = z.object({
  zenotiAppointmentId: z.string().min(1),
  zenotiGuestId: z.string().min(1),
  patientFirstName: z.string().optional().default(""),
  patientLastName: z.string().optional().default(""),
  patientFullName: z.string().min(1),
  patientEmail: z.string().nullable().optional(),
  patientPhone: z.string().nullable().optional(),
  serviceName: z.string(),
  serviceId: z.string().optional().default(""),
  labName: z.string().min(1),
  startAt: z.string().nullable().optional(),
  collectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().nullable().optional(),
  therapistName: z.string().nullable().optional(),
  cancelled: z.boolean().optional().default(false),
});

const Body = z.object({
  appointments: z.array(LabAppointmentInput),
  /** Zenoti appointment IDs that are confirmed cancelled. If a tracker
   * case exists for any of these IDs and isn't already soft-deleted, it
   * will be soft-deleted (deleted_at set + lab_events row appended). */
  cancelledAppointmentIds: z.array(z.string().min(1)).optional().default([]),
});

type SyncResult = {
  zenotiAppointmentId: string;
  caseId: string;
  created: boolean;
};

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
    const json = await request.json();
    parsed = Body.parse(json);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Invalid body: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();
  const results: SyncResult[] = [];
  const errors: { zenotiAppointmentId: string; error: string }[] = [];

  for (const appt of parsed.appointments) {
    // patient_email is NOT NULL in lab_cases; Zenoti may return null for
    // walk-ins / staff-created appts. Use a stable per-guest sentinel so
    // de-duping by email later still works.
    const email =
      appt.patientEmail && appt.patientEmail.trim().length > 0
        ? appt.patientEmail.trim()
        : `${appt.zenotiGuestId}@unknown.zenoti.local`;

    const noteParts: string[] = [];
    noteParts.push(`zenoti: ${appt.serviceName}`);
    if (appt.therapistName) noteParts.push(`therapist: ${appt.therapistName}`);
    if (appt.note) noteParts.push(appt.note);
    const composedNote = noteParts.join(" • ");

    // First, look up an existing row by zenoti_appointment_id.
    const { data: existing, error: lookupErr } = await db
      .from("lab_cases")
      .select("id")
      .eq("zenoti_appointment_id", appt.zenotiAppointmentId)
      .maybeSingle();

    if (lookupErr) {
      errors.push({ zenotiAppointmentId: appt.zenotiAppointmentId, error: lookupErr.message });
      continue;
    }

    if (existing) {
      results.push({
        zenotiAppointmentId: appt.zenotiAppointmentId,
        caseId: existing.id as string,
        created: false,
      });
      continue;
    }

    const insertPayload = {
      patient_name: appt.patientFullName,
      patient_email: email,
      patient_phone: appt.patientPhone ?? null,
      lab_name: appt.labName,
      collection_date: appt.collectionDate ?? null,
      zenoti_appointment_id: appt.zenotiAppointmentId,
      zenoti_guest_id: appt.zenotiGuestId,
      notes: composedNote,
      auto_send_emails: true,
    };

    const { data: inserted, error: insertErr } = await db
      .from("lab_cases")
      .insert(insertPayload)
      .select("id")
      .single();

    if (insertErr || !inserted) {
      errors.push({
        zenotiAppointmentId: appt.zenotiAppointmentId,
        error: insertErr?.message ?? "insert failed",
      });
      continue;
    }

    const caseId = inserted.id as string;

    // Audit trail. lab_events is the existing per-case event log; we add a
    // row so the activity panel shows "Created from Zenoti appointment <id>".
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "case_created",
      actor: "worker:zenoti-sync",
      note: `Auto-created from Zenoti appointment ${appt.zenotiAppointmentId} • ${appt.serviceName}`,
      meta: {
        zenoti_appointment_id: appt.zenotiAppointmentId,
        zenoti_guest_id: appt.zenotiGuestId,
        service_name: appt.serviceName,
        service_id: appt.serviceId,
        start_at: appt.startAt ?? null,
        therapist: appt.therapistName ?? null,
      },
    });

    results.push({
      zenotiAppointmentId: appt.zenotiAppointmentId,
      caseId,
      created: true,
    });
  }

  // ── Cancellations: soft-delete tracker cases that map to cancelled
  //    Zenoti appointments. We use deleted_at (soft-delete) not
  //    archived_at because semantically the appointment never happened —
  //    the case shouldn't sit in Completed lane.
  const cancellations: { zenotiAppointmentId: string; caseId: string | null; action: "deleted" | "skipped" }[] = [];
  for (const zId of parsed.cancelledAppointmentIds) {
    const { data: caseRow, error: lookupErr } = await db
      .from("lab_cases")
      .select("id, deleted_at")
      .eq("zenoti_appointment_id", zId)
      .maybeSingle();
    if (lookupErr) {
      errors.push({ zenotiAppointmentId: zId, error: `cancel lookup: ${lookupErr.message}` });
      continue;
    }
    if (!caseRow) {
      cancellations.push({ zenotiAppointmentId: zId, caseId: null, action: "skipped" });
      continue;
    }
    if (caseRow.deleted_at) {
      cancellations.push({ zenotiAppointmentId: zId, caseId: caseRow.id as string, action: "skipped" });
      continue;
    }
    const { error: delErr } = await db
      .from("lab_cases")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", caseRow.id);
    if (delErr) {
      errors.push({ zenotiAppointmentId: zId, error: `cancel update: ${delErr.message}` });
      continue;
    }
    await db.from("lab_events").insert({
      case_id: caseRow.id,
      kind: "case_deleted",
      actor: "worker:zenoti-sync",
      note: `Soft-deleted: Zenoti appointment ${zId} was cancelled / no-show`,
      meta: { zenoti_appointment_id: zId },
    });
    cancellations.push({ zenotiAppointmentId: zId, caseId: caseRow.id as string, action: "deleted" });
  }

  return NextResponse.json({
    ok: errors.length === 0,
    received: parsed.appointments.length,
    created: results.filter((r) => r.created).length,
    existing: results.filter((r) => !r.created).length,
    cancelledReceived: parsed.cancelledAppointmentIds.length,
    cancelledDeleted: cancellations.filter((c) => c.action === "deleted").length,
    errors,
    results,
    cancellations,
  });
}
