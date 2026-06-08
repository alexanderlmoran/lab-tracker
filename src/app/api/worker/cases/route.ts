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
import { sameLab, sameName } from "@/lib/scrapers/normalize-lab";

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
  /** Per-date census of every appointment ID the worker observed in
   * Zenoti's setDate response (active + cancelled combined). Drives
   * deletion reconciliation: tracker cases on these dates whose
   * zenoti_appointment_id is NOT in the census were hard-deleted in
   * Zenoti and need to be soft-deleted here too. Each entry must cover a
   * COMPLETE day's appointments, otherwise innocent cases get axed. */
  syncedDates: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        allAppointmentIds: z.array(z.string().min(1)),
      }),
    )
    .optional()
    .default([]),
});

// Safety: cases created in the last N minutes are NEVER reconciled away,
// even if their zenoti_appointment_id is missing from the census. Protects
// against races where the sync runs while a case is being created.
const RECONCILE_GRACE_MS = 5 * 60 * 1000;

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

    // First, look up an existing row by zenoti_appointment_id. We include
    // deleted_at because if the case was previously soft-deleted but
    // Zenoti now reports the appointment as active again, we should
    // RESTORE the case rather than create a duplicate or silently leave
    // it deleted.
    const { data: existing, error: lookupErr } = await db
      .from("lab_cases")
      .select("id, deleted_at, zenoti_service_name")
      .eq("zenoti_appointment_id", appt.zenotiAppointmentId)
      .maybeSingle();

    if (lookupErr) {
      errors.push({ zenotiAppointmentId: appt.zenotiAppointmentId, error: lookupErr.message });
      continue;
    }

    if (existing) {
      const existingCaseId = existing.id as string;
      const wasDeleted = Boolean(existing.deleted_at);
      const needsServiceNameBackfill = !existing.zenoti_service_name && appt.serviceName;

      // Restore guard: only restore cases that the SYNC previously deleted.
      // If a human staff member soft-deleted the case via the UI, leave it
      // alone — they had a reason (Zenoti appointment is operationally dead
      // even if the API still echoes it, duplicate booking, etc.). Without
      // this guard, the user's "delete" click and the next sync tick fight
      // forever (Brittany Arnason loop, 2026-05-22).
      let shouldRestore = wasDeleted;
      if (wasDeleted) {
        const { data: lastDelete } = await db
          .from("lab_events")
          .select("actor")
          .eq("case_id", existingCaseId)
          .eq("kind", "case_deleted")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const deletedByUser =
          lastDelete && !(lastDelete.actor as string).startsWith("worker:");
        if (deletedByUser) shouldRestore = false;
      }

      if (shouldRestore || needsServiceNameBackfill) {
        const restorePatch: Record<string, unknown> = {};
        if (shouldRestore) restorePatch.deleted_at = null;
        if (needsServiceNameBackfill)
          restorePatch.zenoti_service_name = appt.serviceName;
        await db.from("lab_cases").update(restorePatch).eq("id", existingCaseId);

        if (shouldRestore) {
          await db.from("lab_events").insert({
            case_id: existingCaseId,
            kind: "case_restored",
            actor: "worker:zenoti-sync",
            note: `Restored: Zenoti appointment ${appt.zenotiAppointmentId} reappeared in sync after prior auto-reconciliation`,
            meta: {
              zenoti_appointment_id: appt.zenotiAppointmentId,
              service_name: appt.serviceName,
            },
          });
        }
      }

      results.push({
        zenotiAppointmentId: appt.zenotiAppointmentId,
        caseId: existingCaseId,
        created: false,
      });
      continue;
    }

    // Adoption: no case carries this appointment id yet. Before creating one,
    // try to ADOPT a recent manual case (no zenoti id) for the same patient +
    // same portal — staff often enter cases by hand before the sync sees them,
    // and we don't want to duplicate. Conservative: recent (≤14d) manual cases
    // only, and adopt ONLY when exactly one matches (a patient with several
    // same-lab cases is ambiguous → leave it, don't risk attaching the wrong one).
    const adoptCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: adoptPool } = await db
      .from("lab_cases")
      .select("id, patient_name, lab_name")
      .is("zenoti_appointment_id", null)
      .is("deleted_at", null)
      .is("archived_at", null)
      .gte("created_at", adoptCutoff);
    const adoptMatches = ((adoptPool ?? []) as Array<{ id: string; patient_name: string; lab_name: string }>).filter(
      (c) => sameName(c.patient_name, appt.patientFullName) && sameLab(c.lab_name, appt.labName),
    );
    if (adoptMatches.length === 1) {
      const adopteeId = adoptMatches[0].id;
      await db
        .from("lab_cases")
        .update({
          zenoti_appointment_id: appt.zenotiAppointmentId,
          zenoti_guest_id: appt.zenotiGuestId,
          zenoti_service_name: appt.serviceName,
        })
        .eq("id", adopteeId);
      await db.from("lab_events").insert({
        case_id: adopteeId,
        kind: "case_adopted",
        actor: "worker:zenoti-sync",
        note: `Adopted manual case into Zenoti appointment ${appt.zenotiAppointmentId} • ${appt.serviceName}`,
        meta: { zenoti_appointment_id: appt.zenotiAppointmentId, service_name: appt.serviceName },
      });
      results.push({ zenotiAppointmentId: appt.zenotiAppointmentId, caseId: adopteeId, created: false });
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
      zenoti_service_name: appt.serviceName,
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

  // ── Deletion reconciliation: catch hard-deletions where Zenoti
  //    forgets the appointment entirely (it disappears from setDate
  //    responses, so the cancellation path above never triggers).
  //    For each synced date, any tracker case with collection_date=date
  //    + zenoti_appointment_id NOT IN the census is presumed deleted.
  const reconcileGraceCutoff = new Date(
    Date.now() - RECONCILE_GRACE_MS,
  ).toISOString();
  const reconciled: { caseId: string; zenotiAppointmentId: string; date: string }[] = [];
  for (const sd of parsed.syncedDates) {
    const { data: existingCases, error: queryErr } = await db
      .from("lab_cases")
      .select("id, zenoti_appointment_id, created_at")
      .eq("collection_date", sd.date)
      .not("zenoti_appointment_id", "is", null)
      .is("deleted_at", null);
    if (queryErr) {
      errors.push({
        zenotiAppointmentId: `reconcile:${sd.date}`,
        error: queryErr.message,
      });
      continue;
    }

    const census = new Set(sd.allAppointmentIds);
    type CaseRow = { id: string; zenoti_appointment_id: string; created_at: string };
    const orphans = ((existingCases ?? []) as CaseRow[]).filter(
      (c) =>
        !census.has(c.zenoti_appointment_id) &&
        c.created_at < reconcileGraceCutoff,
    );

    for (const orphan of orphans) {
      const { error: delErr } = await db
        .from("lab_cases")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", orphan.id);
      if (delErr) {
        errors.push({
          zenotiAppointmentId: orphan.zenoti_appointment_id,
          error: `reconcile delete: ${delErr.message}`,
        });
        continue;
      }
      await db.from("lab_events").insert({
        case_id: orphan.id,
        kind: "case_deleted",
        actor: "worker:zenoti-sync",
        note: `Soft-deleted: Zenoti appointment ${orphan.zenoti_appointment_id} no longer present in ${sd.date} sync (presumed hard-deleted upstream)`,
        meta: {
          zenoti_appointment_id: orphan.zenoti_appointment_id,
          synced_date: sd.date,
          census_size: sd.allAppointmentIds.length,
        },
      });
      reconciled.push({
        caseId: orphan.id,
        zenotiAppointmentId: orphan.zenoti_appointment_id,
        date: sd.date,
      });
    }
  }

  // Heartbeat: the Zenoti sync hits this route every cycle (even with nothing
  // new), so a fresh `last_success_at` here = the sync is alive. The Health tab
  // flags it red when stale, so a stopped sync (e.g. after a worker deploy left
  // the always-on machine stopped) is visible immediately instead of silent.
  await db
    .from("lab_scraper_status")
    .upsert(
      {
        portal_key: "zenoti-sync",
        last_check_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        consecutive_failures: 0,
        last_error: null,
      },
      { onConflict: "portal_key" },
    )
    .then(({ error }) => {
      if (error) console.warn(`[cases] zenoti heartbeat failed: ${error.message}`);
    });

  return NextResponse.json({
    ok: errors.length === 0,
    received: parsed.appointments.length,
    created: results.filter((r) => r.created).length,
    existing: results.filter((r) => !r.created).length,
    cancelledReceived: parsed.cancelledAppointmentIds.length,
    cancelledDeleted: cancellations.filter((c) => c.action === "deleted").length,
    reconciledDeleted: reconciled.length,
    errors,
    results,
    cancellations,
    reconciled,
  });
}
