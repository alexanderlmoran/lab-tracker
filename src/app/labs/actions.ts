"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { getAllPortalsForLab as getAllPortalsForLabDb } from "@/lib/lab-portals/server";
import type { LabPortal } from "@/lib/inbound/detect-notification";
import { testGroupLabel, normalizeTestKey } from "@/lib/labs/label";
import type { ActionResult, LabCase, LabEvent, StepNumber } from "@/lib/types";

export async function fetchPortalsForLab(
  labName: string,
): Promise<LabPortal[]> {
  await requireSignedIn();
  return getAllPortalsForLabDb(labName);
}

const STEP_TO_DB_COL: Record<StepNumber, keyof LabCase> = {
  1: "step1_sample_sent",
  2: "step2_partial_received",
  3: "step3_partial_uploaded",
  4: "step4_complete_received",
  5: "step5_complete_uploaded",
  6: "step6_rof_scheduled",
  7: "step7_rof_completed",
  8: "step8_protocol_emailed",
  9: "step9_sales_followup",
};

const optionalNonEmpty = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v && v.length ? v : null));

const CaseInput = z.object({
  patientName: z.string().trim().min(1).max(200),
  patientEmail: z.string().trim().email().max(200),
  patientPhone: z.string().trim().max(40).optional().transform((v) => (v && v.length ? v : null)),
  patientDob: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v && v.length ? v : null)),
  patientAddress: optionalNonEmpty,
  labName: z.string().trim().min(1).max(100),
  labPanel: z.string().trim().max(100).optional().transform((v) => (v && v.length ? v : null)),
  trackingNumber: z.string().trim().max(100).optional().transform((v) => (v && v.length ? v : null)),
  labExternalRef: z.string().trim().max(64).optional().transform((v) => (v && v.length ? v : null)),
  pickupConfirmation: z.string().trim().max(100).optional().transform((v) => (v && v.length ? v : null)),
  collectionDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v && v.length ? v : null)),
  partialExpected: z.boolean().default(false),
  autoSendEmails: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().transform((v) => (v && v.length ? v : null)),
});

type ParsedCase = z.infer<typeof CaseInput>;

function readForm(formData: FormData): unknown {
  return {
    patientName: formData.get("patientName"),
    patientEmail: formData.get("patientEmail"),
    patientPhone: formData.get("patientPhone") ?? "",
    patientDob: formData.get("patientDob") ?? "",
    patientAddress: formData.get("patientAddress") ?? "",
    labName: formData.get("labName"),
    labPanel: formData.get("labPanel") ?? "",
    trackingNumber: formData.get("trackingNumber") ?? "",
    labExternalRef: formData.get("labExternalRef") ?? "",
    pickupConfirmation: formData.get("pickupConfirmation") ?? "",
    collectionDate: formData.get("collectionDate") ?? "",
    partialExpected: formData.get("partialExpected") === "on",
    autoSendEmails: formData.get("autoSendEmails") === "on",
    notes: formData.get("notes") ?? "",
  };
}

function dbColumns(p: ParsedCase) {
  return {
    patient_name: p.patientName,
    patient_email: p.patientEmail,
    patient_phone: p.patientPhone,
    patient_dob: p.patientDob,
    patient_address: p.patientAddress,
    lab_name: p.labName,
    lab_panel: p.labPanel,
    tracking_number: p.trackingNumber,
    lab_external_ref: p.labExternalRef,
    pickup_confirmation: p.pickupConfirmation,
    collection_date: p.collectionDate,
    partial_expected: p.partialExpected,
    auto_send_emails: p.autoSendEmails,
    notes: p.notes,
  };
}

export async function createLabCase(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireSignedIn();
  const parsed = CaseInput.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .insert(dbColumns(parsed.data))
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Insert failed" };
  }

  await db.from("lab_events").insert({
    case_id: data.id,
    kind: "case_created",
    actor: user.email ?? "admin",
  });

  revalidatePath("/labs");
  return { ok: true, data: { id: data.id } };
}

const LabRowSchema = z.object({
  labName: z.string().trim().min(1).max(100),
  labPanel: z.string().trim().max(100).nullable().optional(),
  trackingNumber: z.string().trim().max(100).nullable().optional(),
  labExternalRef: z.string().trim().max(64).nullable().optional(),
  // Per-row opt-out from the required accession # (in-house services with no
  // lab-portal accession). Enforced below: a row must have an accession or
  // this flag set.
  noAccession: z.boolean().default(false),
  pickupConfirmation: z.string().trim().max(100).nullable().optional(),
  collectionDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .nullable()
    .optional(),
  partialExpected: z.boolean().default(false),
});

/** Bulk create: one patient, N labs from a single submission. The form
 * serializes the lab array as JSON in a hidden `labsJson` input — keeps the
 * server contract simple and avoids inventing bracketed FormData keys. */
export async function createLabCases(
  formData: FormData,
): Promise<ActionResult<{ count: number; ids: string[] }>> {
  const user = await requireSignedIn();

  const patient = z
    .object({
      patientName: z.string().trim().min(1).max(200),
      patientEmail: z.string().trim().email().max(200),
      patientPhone: z
        .string()
        .trim()
        .max(40)
        .optional()
        .transform((v) => (v && v.length ? v : null)),
      patientDob: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
        .optional()
        .or(z.literal(""))
        .transform((v) => (v && v.length ? v : null)),
      patientAddress: optionalNonEmpty,
      autoSendEmails: z.boolean().default(true),
      notes: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .transform((v) => (v && v.length ? v : null)),
    })
    .safeParse({
      patientName: formData.get("patientName"),
      patientEmail: formData.get("patientEmail"),
      patientPhone: formData.get("patientPhone") ?? "",
      patientDob: formData.get("patientDob") ?? "",
      patientAddress: formData.get("patientAddress") ?? "",
      autoSendEmails: formData.get("autoSendEmails") === "on",
      notes: formData.get("notes") ?? "",
    });
  if (!patient.success) {
    return { ok: false, error: patient.error.issues[0]?.message ?? "Invalid patient" };
  }

  const rawJson = formData.get("labsJson");
  if (typeof rawJson !== "string" || rawJson.trim().length === 0) {
    return { ok: false, error: "Add at least one lab." };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: "Lab list was malformed." };
  }
  const labs = z.array(LabRowSchema).min(1).max(20).safeParse(parsedJson);
  if (!labs.success) {
    return { ok: false, error: labs.error.issues[0]?.message ?? "Invalid labs" };
  }

  // Accession # is required per lab unless the row opted out (in-house / N/A).
  const missingAccession = labs.data.find(
    (lab) => !lab.noAccession && !(lab.labExternalRef && lab.labExternalRef.length),
  );
  if (missingAccession) {
    return {
      ok: false,
      error: `Accession # is required for “${missingAccession.labName}”. Enter it, or tick “No accession #”.`,
    };
  }

  const rows = labs.data.map((lab) => ({
    patient_name: patient.data.patientName,
    patient_email: patient.data.patientEmail,
    patient_phone: patient.data.patientPhone,
    patient_dob: patient.data.patientDob,
    patient_address: patient.data.patientAddress,
    lab_name: lab.labName,
    lab_panel: lab.labPanel ?? null,
    tracking_number: lab.trackingNumber ?? null,
    lab_external_ref: lab.labExternalRef ?? null,
    pickup_confirmation: lab.pickupConfirmation ?? null,
    collection_date: lab.collectionDate ?? null,
    partial_expected: lab.partialExpected,
    auto_send_emails: patient.data.autoSendEmails,
    notes: patient.data.notes,
  }));

  const db = getSupabaseAdmin();

  // Dedupe guard (backlog #4 — true duplicate rows): never create a case the
  // patient already has (same lab + panel, not deleted). The Manage-labs grid
  // already blocks this client-side; this is the server-side safety net that
  // also covers the New-case form. Same-lab DIFFERENT-panel rows (Vibrant
  // Zoomer sub-panels) are allowed — only an exact lab+panel repeat is dropped.
  const norm = (v: string | null) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const lpKey = (labName: string, panel: string | null) => `${norm(labName)}|${norm(panel)}`;
  const { data: existingForPatient } = await db
    .from("lab_cases")
    .select("lab_name, lab_panel")
    .eq("patient_email", patient.data.patientEmail)
    .is("deleted_at", null);
  const existsKey = new Set(
    (existingForPatient ?? []).map((c) => lpKey(c.lab_name as string, c.lab_panel as string | null)),
  );
  const fresh = rows.filter((r) => !existsKey.has(lpKey(r.lab_name, r.lab_panel)));
  if (fresh.length === 0) {
    return {
      ok: false,
      error: "That lab already exists for this patient — nothing new to add.",
    };
  }

  const { data, error } = await db.from("lab_cases").insert(fresh).select("id");
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Insert failed" };
  }

  await db.from("lab_events").insert(
    data.map((d) => ({
      case_id: (d as { id: string }).id,
      kind: "case_created" as const,
      actor: user.email ?? "admin",
    })),
  );

  revalidatePath("/labs");
  return {
    ok: true,
    data: { count: data.length, ids: (data as { id: string }[]).map((d) => d.id) },
  };
}

// Patient lab-manager: edit tracking #, accession (lab_external_ref), and
// collection date across SEVERAL of one patient's cases in a single save.
// Only the fields the operator actually changed are written (per-case diff,
// same as updateLabCase), each logged so the activity log shows the edit.
// Pure data writes — no step changes, no emails (the grid uses the existing
// bulkSetStepCompleted for "mark all sample sent").
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BulkFieldUpdateInput = z.object({
  updates: z
    .array(
      z.object({
        caseId: z.string().uuid(),
        trackingNumber: z.string().trim().max(100).nullable().optional(),
        accession: z.string().trim().max(64).nullable().optional(),
        // Explicit intent to CLEAR the accession. Without this, a blank/empty
        // submitted accession is treated as "no change" and will NOT wipe an
        // existing non-null lab_external_ref — a blank field in a bulk save
        // used to null out a good accession (silent data loss / scrape feed
        // drop-out, since open-cases gates on lab_external_ref IS NOT NULL).
        clearAccession: z.boolean().optional(),
        // Same explicit-intent guard for tracking (added 2026-06-25). A blank
        // tracking box on a grid row that's only editing accession/collection
        // used to silently null a good tracking_number.
        clearTracking: z.boolean().optional(),
        collectionDate: z.string().trim().max(10).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export async function bulkUpdatePatientCases(input: {
  updates: Array<{
    caseId: string;
    trackingNumber?: string | null;
    accession?: string | null;
    clearAccession?: boolean;
    clearTracking?: boolean;
    collectionDate?: string | null;
  }>;
}): Promise<ActionResult<{ updated: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkFieldUpdateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // `undefined` = field not touched (leave as-is); null/"" = cleared → null.
  const norm = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v == null || v.trim().length === 0 ? null : v.trim();

  for (const u of parsed.data.updates) {
    const d = norm(u.collectionDate);
    if (d != null && !ISO_DATE.test(d)) {
      return { ok: false, error: "Collection date must be YYYY-MM-DD." };
    }
  }

  const db = getSupabaseAdmin();
  const ids = parsed.data.updates.map((u) => u.caseId);
  const { data: currentRows, error: fetchErr } = await db
    .from("lab_cases")
    .select("id, tracking_number, lab_external_ref, collection_date")
    .in("id", ids);
  if (fetchErr) return { ok: false, error: fetchErr.message };
  const byId = new Map(
    ((currentRows ?? []) as Array<{
      id: string;
      tracking_number: string | null;
      lab_external_ref: string | null;
      collection_date: string | null;
    }>).map((r) => [r.id, r]),
  );

  let updated = 0;
  const events: Array<Record<string, unknown>> = [];
  for (const u of parsed.data.updates) {
    const cur = byId.get(u.caseId);
    if (!cur) continue;
    const patch: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const t = norm(u.trackingNumber);
    // NULL-OVERWRITE GUARD (mirrors accession below): a blank submitted tracking
    // # (t === null) must NOT wipe a good existing tracking_number. Only clear
    // when the caller passes explicit clearTracking intent. (t === undefined
    // already means "field not touched".)
    const wouldClearTracking = t === null && cur.tracking_number != null;
    const skipTracking =
      t === undefined || (wouldClearTracking && u.clearTracking !== true);
    if (!skipTracking && t !== cur.tracking_number) {
      patch.tracking_number = t;
      changes.tracking_number = { from: cur.tracking_number, to: t };
    }
    const a = norm(u.accession);
    // NULL-OVERWRITE GUARD: a blank/empty submitted accession (a === null) must
    // NOT wipe a good existing accession. Only write null over a non-null
    // lab_external_ref when the caller passed explicit clearAccession intent.
    // (a === undefined already means "field not touched".)
    const wouldClearExisting = a === null && cur.lab_external_ref != null;
    const skipAccession =
      a === undefined || (wouldClearExisting && u.clearAccession !== true);
    if (!skipAccession && a !== cur.lab_external_ref) {
      patch.lab_external_ref = a;
      changes.lab_external_ref = { from: cur.lab_external_ref, to: a };
    }
    const d = norm(u.collectionDate);
    if (d !== undefined && d !== cur.collection_date) {
      patch.collection_date = d;
      changes.collection_date = { from: cur.collection_date, to: d };
    }
    if (Object.keys(patch).length === 0) continue;
    const { error } = await db.from("lab_cases").update(patch).eq("id", u.caseId);
    if (error) return { ok: false, error: error.message };
    updated++;
    events.push({
      case_id: u.caseId,
      kind: "case_edited",
      actor: user.email ?? "admin",
      meta: { changes, source: "lab_manager" },
    });
  }
  if (events.length) await db.from("lab_events").insert(events);

  revalidatePath("/labs");
  return { ok: true, data: { updated } };
}

export async function updateLabCase(
  caseId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = CaseInput.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const { data: current, error: fetchErr } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", caseId)
    .single();

  if (fetchErr || !current) {
    return { ok: false, error: "Case not found" };
  }

  const next = dbColumns(parsed.data);
  const update: Record<string, unknown> = { ...next };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next)) {
    const prev = (current as Record<string, unknown>)[k];
    if (prev !== v) changes[k] = { from: prev, to: v };
  }

  // NULL-OVERWRITE GUARD: this is a full-payload diff, so a blank tracking #/
  // accession in the form would write null over a good existing value (an
  // un-hydrated form, a stale render, or an accidentally-cleared box — the
  // recurring "I typed the accession and it vanished" bug, which also drops the
  // case out of the scrape feed since open-cases gates on lab_external_ref).
  // Treat blank as "no change" for these protected fields; changing them means
  // typing a new value, and clearing is an explicit action (Wrong-PDF for
  // accession).
  for (const k of ["tracking_number", "lab_external_ref"] as const) {
    const prev = (current as Record<string, unknown>)[k];
    if (update[k] == null && prev != null) {
      delete update[k];
      delete changes[k];
    }
  }

  // Entering a tracking # does NOT tick step 1 ("Sample sent") — it moves the
  // card to "Ready to ship" (a tracking # = packed return label, not proof the
  // package left the clinic). Step 1 ticks when FedEx actually scans it
  // (refresh-core, on PU/in_transit/delivered). Decoupled 2026-06-09 — see
  // src/lib/labs/pickup.ts and PLAYBOOK "Advance step on tracking".
  if (Object.keys(changes).length === 0) {
    return { ok: true };
  }

  const { error: updateErr } = await db
    .from("lab_cases")
    .update(update)
    .eq("id", caseId);

  if (updateErr) return { ok: false, error: updateErr.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    meta: { changes },
  });

  // DOB belongs to the PATIENT, not this one case (#23). When it changes on the
  // edit form, propagate it across all of the patient's non-deleted cases and
  // into patients_seed so req forms / probes reuse it — same path the "edit
  // patient" dialog uses. Keyed by the case's current email.
  if ("patient_dob" in changes) {
    await updatePatientAcrossCases({
      currentEmail: parsed.data.patientEmail,
      dobIso: parsed.data.patientDob,
    });
  }

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

async function setArchive(
  caseId: string,
  archived: boolean,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", caseId);

  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: archived ? "case_archived" : "case_unarchived",
    actor: user.email ?? "admin",
  });

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function archiveLabCase(caseId: string): Promise<ActionResult> {
  return setArchive(caseId, true);
}

export async function unarchiveLabCase(caseId: string): Promise<ActionResult> {
  return setArchive(caseId, false);
}

/** Staff "Given to patient" toggle — sets/clears `with_patient_at`, which the
 *  board reads to place a card in the "With Patient" lane (when the sample is
 *  not yet sent). Independent of the numbered step1..9 pipeline. */
export async function setWithPatient(
  caseId: string,
  on: boolean,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ with_patient_at: on ? new Date().toISOString() : null })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    note: on ? "Given to patient (kit handed over)" : "Un-marked ‘With Patient’",
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

async function setDeleted(
  caseId: string,
  deleted: boolean,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", caseId);

  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: deleted ? "case_deleted" : "case_restored",
    actor: user.email ?? "admin",
  });

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/deleted");
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function deleteLabCase(caseId: string): Promise<ActionResult> {
  return setDeleted(caseId, true);
}

export async function restoreLabCase(caseId: string): Promise<ActionResult> {
  return setDeleted(caseId, false);
}

const BulkInput = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(200),
});

export async function bulkArchive(input: {
  caseIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await db
    .from("lab_cases")
    .update({ archived_at: now })
    .in("id", parsed.data.caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    parsed.data.caseIds.map((id) => ({
      case_id: id,
      kind: "case_archived" as const,
      actor: user.email ?? "admin",
      meta: { bulk: true },
    })),
  );

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/settings");
  return { ok: true, data: { count: parsed.data.caseIds.length } };
}

export async function bulkUnarchive(input: {
  caseIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ archived_at: null })
    .in("id", parsed.data.caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    parsed.data.caseIds.map((id) => ({
      case_id: id,
      kind: "case_unarchived" as const,
      actor: user.email ?? "admin",
      meta: { bulk: true },
    })),
  );

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/settings");
  return { ok: true, data: { count: parsed.data.caseIds.length } };
}

export async function bulkRestore(input: {
  caseIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ deleted_at: null })
    .in("id", parsed.data.caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    parsed.data.caseIds.map((id) => ({
      case_id: id,
      kind: "case_restored" as const,
      actor: user.email ?? "admin",
      meta: { bulk: true },
    })),
  );

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/deleted");
  revalidatePath("/labs/settings");
  return { ok: true, data: { count: parsed.data.caseIds.length } };
}

const RefreshInput = z.object({
  caseId: z.string().uuid(),
});

export async function refreshLabStatus(input: {
  caseId: string;
}): Promise<
  ActionResult<{
    status: string;
    message?: string;
    adapter: string | null;
  }>
> {
  const user = await requireSignedIn();
  const parsed = RefreshInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", parsed.data.caseId)
    .maybeSingle();
  if (!caseRow) return { ok: false, error: "Case not found" };
  const row = caseRow as LabCase;

  const { getAdapterFor } = await import("@/lib/lab-adapters");
  const adapter = getAdapterFor(row.lab_name);
  if (!adapter) {
    return {
      ok: true,
      data: {
        status: "unknown",
        message: `No adapter for lab "${row.lab_name}". Configure one in src/lib/lab-adapters.`,
        adapter: null,
      },
    };
  }

  const result = await adapter.pullStatus(row);

  await db.from("lab_events").insert({
    case_id: row.id,
    kind: "case_edited",
    actor: user.email ?? "admin",
    meta: {
      lab_pull: true,
      adapter: adapter.labKey,
      remote_status: result.status,
      remote_message: result.message,
      external_ref: result.externalRef,
    },
  });

  revalidatePath(`/labs/${row.id}`);
  return {
    ok: true,
    data: {
      status: result.status,
      message: result.message,
      adapter: adapter.labKey,
    },
  };
}

const BulkStepInput = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(200),
  step: z.number().int().min(1).max(9),
  completed: z.boolean(),
});

/**
 * Bulk-toggle a single step across many cases in one click. Used by the
 * KanbanBoard select mode "Advance step" menu — when staff ship a batch of
 * 10 samples FedEx together, marking step 1 on each one is tedious.
 *
 * Does NOT fire any patient or staff emails (Nadia/Allison triggers are
 * deliberately skipped) because a bulk advance is administrative, not the
 * organic step-by-step workflow those emails are designed to track.
 * Predicted result-date range IS computed when step 1 → true, so cards land
 * with their expected dates set.
 */
export async function bulkSetStepCompleted(input: {
  caseIds: string[];
  step: number;
  completed: boolean;
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkStepInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseIds, step, completed } = parsed.data;
  const stepNum = step as StepNumber;
  const dbCol = STEP_TO_DB_COL[stepNum];
  const db = getSupabaseAdmin();

  // Step 1 toggles also touch the expected-date range; rather than reproduce
  // that whole calculation here, fall back to per-row setStepCompleted for
  // step 1. The per-row helper already skips emails (those only fire from
  // step 5/6) so the "no emails fire" guarantee still holds.
  if (stepNum === 1) {
    let count = 0;
    for (const id of caseIds) {
      const r = await setStepCompleted({ caseId: id, step, completed });
      if (r.ok) count += 1;
    }
    revalidatePath("/labs");
    return { ok: true, data: { count } };
  }

  const { error } = await db
    .from("lab_cases")
    .update({ [dbCol]: completed })
    .in("id", caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    caseIds.map((id) => ({
      case_id: id,
      kind: "step_toggled" as const,
      step,
      completed,
      actor: user.email ?? "admin",
      meta: { bulk: true },
      note: `Bulk ${completed ? "advanced" : "rolled back"} step ${step}`,
    })),
  );

  revalidatePath("/labs");
  return { ok: true, data: { count: caseIds.length } };
}

export async function bulkDelete(input: {
  caseIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = BulkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await db
    .from("lab_cases")
    .update({ deleted_at: now })
    .in("id", parsed.data.caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    parsed.data.caseIds.map((id) => ({
      case_id: id,
      kind: "case_deleted" as const,
      actor: user.email ?? "admin",
      meta: { bulk: true },
    })),
  );

  revalidatePath("/labs");
  revalidatePath("/labs/archived");
  revalidatePath("/labs/deleted");
  revalidatePath("/labs/settings");
  return { ok: true, data: { count: parsed.data.caseIds.length } };
}

const MergePatientsInput = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(200),
  // Canonical identity every merged case is reassigned onto.
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200),
});

/**
 * Merge several patients into one (#17). Staff pick the cases (e.g. the same
 * person split across two spellings or two emails) plus the canonical
 * name/email; every selected case is reassigned onto that identity so they
 * collapse into a single patient group on the By-patient board.
 *
 * Identity-only: never touches lab/step/tracking state. Reuses the same
 * lab_cases update + per-case `case_edited` audit pattern as
 * `updatePatientAcrossCases` (which reassigns by old email) rather than
 * forking it — this variant targets an explicit case-id set instead.
 */
export async function mergePatients(input: {
  caseIds: string[];
  email: string;
  name: string;
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireSignedIn();
  const parsed = MergePatientsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseIds, email, name } = parsed.data;
  const db = getSupabaseAdmin();

  const { error } = await db
    .from("lab_cases")
    .update({ patient_email: email, patient_name: name })
    .in("id", caseIds);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert(
    caseIds.map((id) => ({
      case_id: id,
      kind: "case_edited" as const,
      actor: user.email ?? "admin",
      meta: { merged_patient: { email, name }, bulk: true },
      note: `Merged into patient "${name}" <${email}>`,
    })),
  );

  revalidatePath("/labs");
  return { ok: true, data: { count: caseIds.length } };
}

const MergeByDateInput = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(200),
  collectionDate: z.string().trim().regex(ISO_DATE, "Use YYYY-MM-DD"),
});

/**
 * Merge selected cases onto one collection date (#17) — patients draw 2–7
 * labs in one sitting (often one box), so stamping a shared collection_date
 * makes them group as a single dated batch (see `groupByDate`). Thin wrapper
 * over `bulkUpdatePatientCases` so the date write + audit logging stay in one
 * place; we don't reimplement the per-row diff/event logic here.
 */
export async function mergeCasesByDate(input: {
  caseIds: string[];
  collectionDate: string;
}): Promise<ActionResult<{ updated: number }>> {
  const parsed = MergeByDateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  return bulkUpdatePatientCases({
    updates: parsed.data.caseIds.map((caseId) => ({
      caseId,
      collectionDate: parsed.data.collectionDate,
    })),
  });
}

const StepToggleInput = z.object({
  caseId: z.string().uuid(),
  step: z.number().int().min(1).max(9),
  completed: z.boolean(),
  note: z.string().trim().max(500).optional(),
  // When toggling a step forward, also set every workflow-prior step true.
  // No emails are fired for the cascaded steps — patient emails are still
  // only ever sent via the explicit Send-email button. Used when staff
  // backfills a case that was completed outside the app.
  cascadePrior: z.boolean().optional(),
  // When set, apply the SAME toggle to every same-accession sibling (one
  // physical order split across cards) so they move columns together instead
  // of orphaning one card behind. Mirrors the approve/already-on-PB cascade.
  cascadeSiblings: z.boolean().optional(),
});

export async function setStepCompleted(input: {
  caseId: string;
  step: number;
  completed: boolean;
  note?: string;
  cascadePrior?: boolean;
  cascadeSiblings?: boolean;
  /** Internal (sibling-cascade replays only): apply the toggle without firing
   * the Nadia/Allison group emails — the cascade fires them once at the end. */
  _skipWorkflowEmails?: boolean;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = StepToggleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, step, completed, note, cascadePrior, cascadeSiblings } = parsed.data;
  const skipWorkflowEmails = input._skipWorkflowEmails === true;

  // ── Stage guard (staff moves only) ──────────────────────────────────────
  // The automated result pipeline sets these booleans directly (not via this
  // signed-in action), and internal sibling replays pass _skipWorkflowEmails —
  // both bypass this. Alex 2026-07-01:
  //   • No skipping: the upload lanes (Pending Upload = step 4, Upload Complete =
  //     step 5) require Sample Sent (step 1) already done.
  //   • Upload Complete (step 5) additionally requires a result PDF on the case
  //     OR a same-accession sibling — a card can't be marked posted-to-PB with
  //     nothing to post.
  // (The "Sample Sent without a tracking number" case is warn-only — a card flag,
  //  never a block — so it is intentionally NOT guarded here.)
  if (!skipWorkflowEmails && completed && (step === 4 || step === 5)) {
    const guardDb = getSupabaseAdmin();
    const { data: guardRow } = await guardDb
      .from("lab_cases")
      .select("step1_sample_sent")
      .eq("id", caseId)
      .maybeSingle();
    if (guardRow && !guardRow.step1_sample_sent) {
      return { ok: false, error: "Mark Sample Sent first — the upload lanes can't be skipped." };
    }
    if (step === 5) {
      const { accessionSiblingIds } = await import("@/lib/labs/siblings");
      const groupIds = await accessionSiblingIds(caseId);
      const { count } = await guardDb
        .from("lab_case_pdfs")
        .select("id", { head: true, count: "exact" })
        .in("case_id", groupIds.length ? groupIds : [caseId])
        .is("superseded_at", null);
      if (!count) {
        return { ok: false, error: "Attach the result PDF before marking Upload Complete." };
      }
    }
  }

  // Move the whole same-accession group together. Resolve the lead card first
  // (this call), then replay the identical toggle on each sibling WITHOUT
  // re-cascading siblings (avoids loops). The replays SUPPRESS the Nadia/
  // Allison triggers — otherwise one click fires the per-case email once PER
  // sibling — and the group-level email fires exactly once below, after the
  // whole group has moved (so the Nadia all-at-step-5 gate sees final state).
  if (cascadeSiblings) {
    const { accessionSiblingIds } = await import("@/lib/labs/siblings");
    const ids = await accessionSiblingIds(caseId);
    const siblingIds = ids.filter((id) => id !== caseId);
    const lead = await setStepCompleted({
      caseId, step, completed, note, cascadePrior, _skipWorkflowEmails: true,
    });
    if (!lead.ok) return lead;
    for (const sibId of siblingIds) {
      const r = await setStepCompleted({
        caseId: sibId, step, completed, note, cascadePrior, _skipWorkflowEmails: true,
      });
      if (!r.ok) return r;
    }
    if (completed && step === 5) {
      try {
        const { maybeFireNadiaAllReceived } = await import("@/lib/workflow");
        await maybeFireNadiaAllReceived(caseId, user.email ?? "admin");
      } catch (err) {
        console.error("[workflow] nadia trigger failed", err);
      }
    }
    if (completed && step === 6) {
      try {
        const { maybeFireAllisonRof } = await import("@/lib/workflow");
        await maybeFireAllisonRof(caseId, user.email ?? "admin");
        // Stamp the siblings too (no extra email): the one email covered the
        // patient's packet, and the stamp keeps a later direct step-6 toggle
        // on a sibling from re-emailing Allison for the same physical order.
        if (siblingIds.length > 0) {
          await getSupabaseAdmin()
            .from("lab_cases")
            .update({
              allison_rof_emailed_at: new Date().toISOString(),
              step9_sales_followup: true,
            })
            .in("id", siblingIds)
            .is("allison_rof_emailed_at", null);
        }
      } catch (err) {
        console.error("[workflow] allison trigger failed", err);
      }
    }
    return { ok: true };
  }
  const stepNum = step as StepNumber;
  const dbCol = STEP_TO_DB_COL[stepNum];

  const db = getSupabaseAdmin();

  const updatePayload: Record<string, unknown> = { [dbCol]: completed };
  let expectedDatesEvent: { min: string | null; max: string | null } | null = null;
  let armTracking = false; // see post-update step below

  // Cascade: when ticking a later step true, auto-tick every workflow-prior
  // step too. Compute which steps actually transition false→true here so
  // we can emit one step_toggled event per change and only run step-1
  // side-effects when step 1 itself transitions.
  const cascadedNewlySet: StepNumber[] = [];
  let step1NewlySet = stepNum === 1 && completed;
  if (cascadePrior && completed && stepNum > 1) {
    const { getCaseWorkflow, getWorkflowSteps } = await import("@/lib/columns");
    const { data: stateRow } = await db
      .from("lab_cases")
      .select(
        "lab_name, step1_sample_sent, step2_partial_received, step3_partial_uploaded, step4_complete_received, step5_complete_uploaded, step6_rof_scheduled, step7_rof_completed, step8_protocol_emailed, step9_sales_followup",
      )
      .eq("id", caseId)
      .maybeSingle();
    if (stateRow?.lab_name) {
      const workflow = getCaseWorkflow({ lab_name: stateRow.lab_name } as Pick<LabCase, "lab_name">);
      const workflowSteps = getWorkflowSteps(workflow);
      const targetIdx = workflowSteps.indexOf(stepNum);
      if (targetIdx > 0) {
        for (const s of workflowSteps.slice(0, targetIdx)) {
          const col = STEP_TO_DB_COL[s];
          if (!stateRow[col as keyof typeof stateRow]) {
            updatePayload[col] = true;
            cascadedNewlySet.push(s);
            if (s === 1) step1NewlySet = true;
          }
        }
      }
    }
  }

  // Step 1 → true sets the predicted result-date range from the catalog;
  // toggling step 1 back to false clears it. Runs for explicit step-1
  // toggles AND for cascades that newly set step 1.
  if (stepNum === 1 && !completed) {
    updatePayload.expected_result_at_min = null;
    updatePayload.expected_result_at_max = null;
  }
  if (step1NewlySet) {
    {
      const { data: caseRow } = await db
        .from("lab_cases")
        .select("lab_name, lab_panel, collection_date, tracking_number, tracking_polled_at")
        .eq("id", caseId)
        .maybeSingle();
      if (caseRow?.lab_name) {
        const { predictResultDates } = await import("@/lib/labs/catalog");
        const { getEffectiveLab } = await import("@/lib/labs/effective");
        const joined = caseRow.lab_panel
          ? `${caseRow.lab_name} ${caseRow.lab_panel}`
          : caseRow.lab_name;
        const entry =
          (await getEffectiveLab(joined)) ??
          (await getEffectiveLab(caseRow.lab_name));
        if (entry) {
          // Prefer collection_date as the anchor when present — it's the
          // true "sample collected" moment. Fall back to now() for cases
          // where the user hasn't recorded one (legacy rows).
          const anchor = caseRow.collection_date
            ? new Date(`${caseRow.collection_date}T00:00:00Z`)
            : new Date();
          const { minIso, maxIso } = predictResultDates(anchor, entry);
          updatePayload.expected_result_at_min = minIso;
          updatePayload.expected_result_at_max = maxIso;
          if (minIso || maxIso) expectedDatesEvent = { min: minIso, max: maxIso };
        }
      }
      // Auto-arm a FedEx poll when sample-sent is checked and we have a
      // tracking number on file — skips waiting for the once-a-day cron.
      // Skipped when we polled in the last hour to avoid hammering FedEx if
      // the user clicks-and-unclicks.
      if (caseRow?.tracking_number) {
        const polledAt = caseRow.tracking_polled_at
          ? new Date(caseRow.tracking_polled_at).getTime()
          : 0;
        if (Date.now() - polledAt > 60 * 60 * 1000) armTracking = true;
      }
    }
  }

  const { error: updateErr } = await db
    .from("lab_cases")
    .update(updatePayload)
    .eq("id", caseId);
  if (updateErr) return { ok: false, error: updateErr.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "step_toggled",
    step,
    completed,
    actor: user.email ?? "admin",
    note: note ?? null,
  });

  if (cascadedNewlySet.length > 0) {
    await db.from("lab_events").insert(
      cascadedNewlySet.map((s) => ({
        case_id: caseId,
        kind: "step_toggled" as const,
        step: s,
        completed: true,
        actor: user.email ?? "admin",
        note: `Auto-set by cascade from step ${step}`,
      })),
    );
  }

  if (expectedDatesEvent) {
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "expected_dates_set",
      actor: user.email ?? "admin",
      note: `Predicted: ${expectedDatesEvent.min ?? "—"} to ${expectedDatesEvent.max ?? "—"}`,
    });
  }

  // Sample shipped (step 1 set directly or via cascade) → the kit is no longer
  // with the patient: clear the pre-ship "With Patient" marker so an un-tick
  // correction returns the card to Ready to Ship, not back to With Patient.
  if (completed && (step === 1 || cascadedNewlySet.includes(1))) {
    await db.from("lab_cases").update({ with_patient_at: null }).eq("id", caseId);
  }

  // Best-effort: when step 1 just flipped true and the case has a tracking
  // number that hasn't been polled in the last hour, kick off a FedEx
  // refresh now instead of waiting for the next cron tick. Failures here
  // must not block the step toggle — log and move on.
  if (armTracking) {
    try {
      const { refreshTrackingForCase } = await import("./tracking-actions");
      await refreshTrackingForCase(caseId);
    } catch (err) {
      console.error("[step1] auto-arm tracking failed", err);
    }
  }

  // Step 5 (complete results uploaded) → fire Nadia outreach when all of
  // the patient's active labs are at step 5. PracticeBetter auto-push lived
  // here too; removed 2026-05-12 along with the rest of the abandoned PB
  // integration.
  if (completed && step === 5 && !skipWorkflowEmails) {
    try {
      const { maybeFireNadiaAllReceived } = await import("@/lib/workflow");
      await maybeFireNadiaAllReceived(caseId, user.email ?? "admin");
    } catch (err) {
      console.error("[workflow] nadia trigger failed", err);
    }
  }

  // Step 6 (ROF booked) → email Allison + auto-tick step 9.
  if (completed && step === 6 && !skipWorkflowEmails) {
    try {
      const { maybeFireAllisonRof } = await import("@/lib/workflow");
      await maybeFireAllisonRof(caseId, user.email ?? "admin");
    } catch (err) {
      console.error("[workflow] allison trigger failed", err);
    }
  }

  // NOTE (backlog #11): the patient-facing tracker emails (sample_sent /
  // partial_uploaded / complete_uploaded / rof_followup) are intentionally
  // NOT auto-dispatched here — they fire only via the explicit Send-email
  // button in StepChecklist (with its confirm dialog). The per-case
  // `auto_send_emails` flag is currently vestigial (stored + shown, never
  // read for dispatch); wiring it to auto-send on toggle is a product
  // decision left to the owner because the flag defaults true on every
  // existing/imported/worker-created case, so flipping it live would blast
  // patient emails on historical step toggles. The INTERNAL staff emails
  // (Nadia @ step 5, Allison @ step 6) do auto-fire above, as designed.

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

/**
 * Bulk-advance a case to "Closed" — sets every step boolean (except 2/3
 * when partial_expected = false, which stay skipped) to true in one update.
 * No emails fire even though steps 1/3/5/7 normally have email gates: the
 * intent here is "this case is historically done, mark it shipped" — sending
 * patient emails for past activity would be wrong.
 *
 * Used by the "Mark as closed" shortcut in CaseDetail. Reversible via the
 * existing per-step toggle (untick step 9 → card leaves Closed).
 */
export async function markCaseClosed(
  caseId: string,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: caseRow, error: fetchErr } = await db
    .from("lab_cases")
    .select("partial_expected, lab_name")
    .eq("id", caseId)
    .maybeSingle();
  if (fetchErr || !caseRow) {
    return { ok: false, error: fetchErr?.message ?? "Case not found" };
  }

  // Peptides only have two relevant steps (shipped + received) — closing
  // a peptides card just means both are ticked. No partial/complete/ROF
  // chain to fill in.
  const isPeptides = caseRow.lab_name === "Peptides";
  const updatePayload: Record<string, boolean> = isPeptides
    ? {
        step1_sample_sent: true,
        step4_complete_received: true,
      }
    : {
        step1_sample_sent: true,
        step4_complete_received: true,
        step5_complete_uploaded: true,
        step6_rof_scheduled: true,
        step7_rof_completed: true,
        step8_protocol_emailed: true,
        step9_sales_followup: true,
      };
  if (!isPeptides && caseRow.partial_expected) {
    updatePayload.step2_partial_received = true;
    updatePayload.step3_partial_uploaded = true;
  }

  const { error: updateErr } = await db
    .from("lab_cases")
    .update(updatePayload)
    .eq("id", caseId);
  if (updateErr) return { ok: false, error: updateErr.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    note: "Marked as closed (bulk step advance, no emails fired)",
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

const AttachScanInput = z.object({
  caseId: z.string().uuid(),
  trackingNumber: z.string().trim().min(3).max(100),
});

/**
 * "Scan kit barcode at intake": attaches a tracking number to a case AND,
 * when step 1 isn't already ticked, advances step 1 + arms a FedEx poll.
 * Designed for the case-detail Scan button — staff scans the kit they're
 * shipping, and the case lands in "Sample sent" in one motion.
 *
 * Idempotent on the tracking number: scanning the same code twice is a no-op
 * (won't re-fire the event log).
 */
export async function attachTrackingFromScan(input: {
  caseId: string;
  trackingNumber: string;
}): Promise<
  ActionResult<{ readyToShip: boolean; trackingChanged: boolean }>
> {
  const user = await requireSignedIn();
  const parsed = AttachScanInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, trackingNumber } = parsed.data;
  const db = getSupabaseAdmin();

  const { data: row, error: fetchErr } = await db
    .from("lab_cases")
    .select("id, tracking_number, step1_sample_sent")
    .eq("id", caseId)
    .maybeSingle();
  if (fetchErr || !row) {
    return { ok: false, error: fetchErr?.message ?? "Case not found" };
  }

  const trackingChanged = row.tracking_number !== trackingNumber;
  // Scanning a return label attaches the tracking # and moves the card to
  // "Ready to ship" — it does NOT tick step 1. Step 1 ticks when FedEx scans
  // the package (refresh-core). The cron poller selects cases by tracking #
  // regardless of step 1, so this card still gets polled. Decoupled 2026-06-09.
  const readyToShip = !row.step1_sample_sent;

  if (trackingChanged) {
    const { error: updErr } = await db
      .from("lab_cases")
      .update({ tracking_number: trackingNumber })
      .eq("id", caseId);
    if (updErr) return { ok: false, error: updErr.message };
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "case_edited",
      actor: user.email ?? "admin",
      meta: {
        scan: true,
        from: row.tracking_number,
        to: trackingNumber,
      },
      note: "Tracking number attached by barcode scan",
    });
  }

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true, data: { readyToShip, trackingChanged } };
}

export async function listLabEvents(caseId: string): Promise<LabEvent[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  // lab_events: existing per-case step/email/edit log.
  const eventsP = db
    .from("lab_events")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(200);

  // lab_case_audit: PDF approval workflow (approve / disapprove / upload
  // failure / retry / accession edits). Append-only.
  const auditP = db
    .from("lab_case_audit")
    .select("id, action, actor_label, notes, meta, occurred_at")
    .eq("case_id", caseId)
    .order("occurred_at", { ascending: false })
    .limit(200);

  const [eventsRes, auditRes] = await Promise.all([eventsP, auditP]);
  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (auditRes.error) throw new Error(auditRes.error.message);

  const events = (eventsRes.data ?? []) as LabEvent[];

  // Map audit rows into the LabEvent shape so the panel can render them
  // alongside lab_events. We use a synthetic kind prefix `audit_*` and route
  // it through ActivityLog's describe() switch.
  type AuditRow = {
    id: string;
    action: string;
    actor_label: string;
    notes: string | null;
    meta: Record<string, unknown> | null;
    occurred_at: string;
  };
  const auditAsEvents: LabEvent[] = (auditRes.data as AuditRow[] | null ?? []).map(
    (r) => ({
      id: `audit:${r.id}`,
      case_id: caseId,
      kind: `audit_${r.action}` as LabEvent["kind"],
      step: null,
      completed: null,
      actor: r.actor_label,
      note: r.notes,
      meta: r.meta,
      created_at: r.occurred_at,
    }),
  );

  return [...events, ...auditAsEvents].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
}

export async function getLabCase(caseId: string): Promise<LabCase | null> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LabCase | null) ?? null;
}

export type LabCaseView = "active" | "archived" | "deleted";

export type LabCaseFilters = {
  /** Free-text query — matches patient_name, patient_email, tracking_number,
   *  and the lab/test (lab_name, lab_panel, zenoti_service_name) so you can
   *  search by a specific test like "eboo waste". */
  q?: string;
  /** Exact lab_name match. */
  lab?: string;
  /** Exact test/panel match (the panelFor() label sent by the test dropdown). */
  test?: string;
  /** Time window — restrict to cases whose collection (service) date falls within the last N days. */
  sinceDays?: number;
};

function escapePostgrestPattern(s: string): string {
  // PostgREST `ilike` uses `*` as wildcard. Strip user `*` so they don't
  // inject their own pattern, and escape commas/parens which terminate the
  // filter expression.
  return s.replace(/[*,()]/g, "");
}

// Columns the free-text `q` search matches — ONE list shared by every board's
// search box (listLabCases + listRecordsCases) so a new searchable field can't
// be added to one and forgotten on the other. lab_name/lab_panel/
// zenoti_service_name make a specific test (e.g. "eboo waste") findable.
const Q_SEARCH_COLUMNS = [
  "patient_name",
  "patient_email",
  "tracking_number",
  "lab_name",
  "lab_panel",
  "zenoti_service_name",
] as const;

function qSearchOr(pattern: string): string {
  return Q_SEARCH_COLUMNS.map((c) => `${c}.ilike.${pattern}`).join(",");
}

// Distinct-label dedup shared by the lab and test dropdowns: collapse case/
// format variants of a label under `keyOf`, and surface the spelling used by
// the most cases (ties broken alphabetically). One source of truth for both
// dropdowns so a normalization tweak can't drift between them.
function mostCommonByKey<T>(
  rows: T[],
  pick: (r: T) => string | null | undefined,
  keyOf: (label: string) => string,
): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const label = pick(r)?.trim();
    if (!label) continue;
    const key = keyOf(label);
    const counts = groups.get(key) ?? new Map<string, number>();
    counts.set(label, (counts.get(label) ?? 0) + 1);
    groups.set(key, counts);
  }
  const labels: string[] = [];
  for (const counts of groups.values()) {
    const best = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (best) labels.push(best[0]);
  }
  return labels.sort((a, b) => a.localeCompare(b));
}

// The test/panel filter narrows server-side on a SAFE token (the panel's first
// word) so we filter the whole table — not just the row-capped page — then the
// caller refines in JS with testGroupLabel (the exact group can't be one
// PostgREST clause: the panel may live in lab_panel OR be parsed from
// zenoti_service_name, and all peptides fold into one group). The token match is
// always a superset of the precise match, so the JS refine never loses a row.
function narrowByTestToken<B extends { or(filters: string): B }>(
  builder: B,
  test: string,
): B {
  const token = escapePostgrestPattern(test.trim().split(/\s+/)[0] ?? "");
  if (!token) return builder;
  const pat = `*${token}*`;
  return builder.or(
    [
      `lab_name.ilike.${pat}`,
      `lab_panel.ilike.${pat}`,
      `zenoti_service_name.ilike.${pat}`,
    ].join(","),
  );
}

function rowsMatchingTest(rows: LabCase[], test: string | undefined): LabCase[] {
  const key = test?.trim() ? normalizeTestKey(test) : "";
  if (!key) return rows;
  return rows.filter((c) => normalizeTestKey(testGroupLabel(c)) === key);
}

export async function listLabCases(opts: {
  view?: LabCaseView;
  filters?: LabCaseFilters;
  /** @deprecated use `view`. Retained so older call sites keep compiling. */
  archived?: boolean;
}): Promise<LabCase[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const view: LabCaseView =
    opts.view ?? (opts.archived ? "archived" : "active");
  const query = db.from("lab_cases").select("*");
  let filtered;
  if (view === "deleted") {
    filtered = query.not("deleted_at", "is", null);
  } else if (view === "archived") {
    filtered = query.not("archived_at", "is", null).is("deleted_at", null);
  } else {
    filtered = query.is("archived_at", null).is("deleted_at", null);
  }

  const q = opts.filters?.q?.trim();
  if (q) {
    filtered = filtered.or(qSearchOr(`*${escapePostgrestPattern(q)}*`));
  }

  const lab = opts.filters?.lab?.trim();
  if (lab) {
    // The dropdown sends one deduped label per lab; match every case/format
    // variant of it via a prefix ilike on the base (before " · "). Escape the
    // ilike metacharacters so a lab name with % or _ stays literal.
    const base = lab.split("·")[0].trim().replace(/[%_\\]/g, (m) => `\\${m}`);
    filtered = filtered.ilike("lab_name", `${base}%`);
  }

  const test = opts.filters?.test?.trim();
  if (test) filtered = narrowByTestToken(filtered, test);

  const sinceDays = opts.filters?.sinceDays;
  if (typeof sinceDays === "number" && sinceDays > 0) {
    // collection_date is a DATE column (yyyy-mm-dd) — compare against a date string.
    // Cases with no collection_date are excluded from windowed views; use "All time" to see them.
    const cutoff = new Date(Date.now() - sinceDays * 86400000)
      .toISOString()
      .slice(0, 10);
    filtered = filtered.gte("collection_date", cutoff);
  }

  const { data, error } = await filtered.order("updated_at", {
    ascending: false,
  });
  if (error) throw new Error(error.message);
  // Precise test/panel match (the server-side narrowing above is only a coarse
  // superset). normalizeTestKey keeps this in lock-step with the dropdown's
  // option grouping so no whitespace/case variant is silently dropped.
  return rowsMatchingTest((data ?? []) as LabCase[], test);
}

/**
 * The in-app records portal (backlog #22): EVERY non-deleted lab case — active
 * AND archived — so staff can look up "what labs has this patient had, and
 * where is each one" without opening PracticeBetter or Zenoti.
 *
 * Returns a flat list ordered newest-first by collection_date (the clinically
 * meaningful date), falling back to created_at when a case has no draw date.
 * The page groups by patient; we keep the action flat (one query, one shape) so
 * filtering stays in PostgREST. Reuses the same q/lab/since filter handling as
 * `listLabCases` — deliberately one source of truth for those clauses.
 *
 * SCOPE: this covers only cases that already live in `lab_cases`. The full
 * #22 ask ("ALL labs by ALL patients June 2025 → now") needs a historical
 * backfill of orders that never became a tracker case — see PHASE 2 note below.
 */
export async function listRecordsCases(opts?: {
  filters?: LabCaseFilters;
}): Promise<LabCase[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  // Active + archived = everything except soft-deleted. No archived/deleted
  // predicate beyond excluding deleted_at, so one query spans both lanes.
  let filtered = db.from("lab_cases").select("*").is("deleted_at", null);

  const q = opts?.filters?.q?.trim();
  if (q) {
    filtered = filtered.or(qSearchOr(`*${escapePostgrestPattern(q)}*`));
  }

  const lab = opts?.filters?.lab?.trim();
  if (lab) {
    const base = lab.split("·")[0].trim().replace(/[%_\\]/g, (m) => `\\${m}`);
    filtered = filtered.ilike("lab_name", `${base}%`);
  }

  const test = opts?.filters?.test?.trim();
  if (test) filtered = narrowByTestToken(filtered, test);

  const sinceDays = opts?.filters?.sinceDays;
  if (typeof sinceDays === "number" && sinceDays > 0) {
    const cutoff = new Date(Date.now() - sinceDays * 86400000)
      .toISOString()
      .slice(0, 10);
    filtered = filtered.gte("collection_date", cutoff);
  }

  // collection_date is the clinical anchor; nulls sort last so undated cases
  // don't crowd the top. created_at is the page-side tiebreaker.
  const { data, error } = await filtered.order("collection_date", {
    ascending: false,
    nullsFirst: false,
  });
  if (error) throw new Error(error.message);
  // Precise test/panel match — shared with listLabCases (same source of truth).
  return rowsMatchingTest((data ?? []) as LabCase[], test);
}

/** Distinct lab names across non-deleted cases — for the filter dropdown. */
/** Effective catalog for the New/Edit case combobox. Merges editable DB rows
 * over the code catalog. Client-side fallback to the code catalog if this
 * call fails — the dropdown stays useful even when the table is unavailable. */
export async function listEffectiveLabsForPicker() {
  await requireSignedIn();
  const { listEffectiveLabs } = await import("@/lib/labs/effective");
  const entries = await listEffectiveLabs();
  return entries.map((e) => ({
    name: e.name,
    provider: e.provider,
    panel: e.panel,
    turnaroundDaysMin: e.turnaroundDaysMin,
    turnaroundDaysMax: e.turnaroundDaysMax,
    retired: e.retired ?? false,
    partialExpected: e.partialExpected ?? false,
  }));
}

/** Normalized group key that collapses case + a "Labs -/·" prefix + the
 *  " · panel" suffix, so variant spellings of one lab share a key.
 *  "Access"/"access"/"access · custom" → "access"; "Peptides · Semax…" →
 *  "peptides"; "Vibrant · EBOO Waste" → "vibrant".
 *  NOT exported — this file is "use server", where only async functions may be
 *  exported (a sync export breaks the Next build). Keep it module-private. */
function labGroupKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^labs\s*[·-]\s*/, "")
    .split("·")[0]
    .replace(/\s+/g, " ")
    .trim();
}

export async function listDistinctLabNames(): Promise<string[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("lab_name")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  // Collapse case/format variants of the same lab so the dropdown shows ONE
  // entry per lab (most-common spelling wins). The picker sends that label and
  // listLabCases matches every variant of it (prefix ilike).
  return mostCommonByKey(
    (data ?? []) as Array<{ lab_name: string }>,
    (r) => r.lab_name,
    labGroupKey,
  );
}

/** Distinct test/panel labels for the test filter dropdown. Keys on the test
 *  group (via testGroupLabel, which recovers the panel from lab_panel or the
 *  Zenoti service string and folds all peptides into "Peptides"), normalized by
 *  normalizeTestKey — the SAME key listLabCases matches on, so the option and
 *  the cases it represents can never disagree. */
export async function listDistinctPanels(): Promise<string[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("lab_name, lab_panel, zenoti_service_name")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  return mostCommonByKey(
    (data ?? []) as Array<
      Pick<LabCase, "lab_name" | "lab_panel" | "zenoti_service_name">
    >,
    (r) => testGroupLabel(r),
    normalizeTestKey,
  );
}

export type PatientSummary = {
  patient_email: string;
  patient_name: string;
  case_count: number;
  active_count: number;
  archived_count: number;
  deleted_count: number;
  last_activity_at: string;
  patient_phone: string | null;
};

/**
 * Every non-deleted lab case for one patient (matched case-insensitively by
 * email). Returns active and archived rows; the caller distinguishes via the
 * archived_at column. Used by the "By patient" focus view.
 */
export async function listPatientCases(
  emailLower: string,
): Promise<LabCase[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("*")
    .ilike("patient_email", emailLower)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as LabCase[];
}

const PatientUpdateInput = z.object({
  currentEmail: z.string().email().max(200),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  dobIso: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

/**
 * Update a patient's identity across every one of their non-deleted lab
 * cases in one operation. The app stores patient_name/email/phone/dob
 * directly on lab_cases (no separate patients table), so "edit the
 * patient" is a bulk-update over all their rows keyed by current email.
 *
 * If a row exists in patients_seed for the same email, that row is
 * updated too so the corrected info survives the next CSV re-import.
 *
 * Caller passes only the fields they want changed; undefined fields are
 * left untouched. Returns the number of cases + seed rows updated.
 */
export async function updatePatientAcrossCases(input: {
  currentEmail: string;
  name?: string;
  email?: string;
  phone?: string | null;
  dobIso?: string | null;
}): Promise<ActionResult<{ casesUpdated: number; seedUpdated: number }>> {
  const user = await requireSignedIn();
  const parsed = PatientUpdateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();

  const update: Record<string, string | null> = {};
  if (parsed.data.name !== undefined) update.patient_name = parsed.data.name;
  if (parsed.data.email !== undefined) update.patient_email = parsed.data.email;
  if (parsed.data.phone !== undefined) update.patient_phone = parsed.data.phone;
  if (parsed.data.dobIso !== undefined) update.patient_dob = parsed.data.dobIso;
  if (Object.keys(update).length === 0) {
    return { ok: true, data: { casesUpdated: 0, seedUpdated: 0 } };
  }

  const currentEmailLower = parsed.data.currentEmail.toLowerCase();

  // Pull affected case IDs first so we can log per-case events. ilike to
  // be case-insensitive, deleted rows skipped.
  const { data: affected, error: fetchErr } = await db
    .from("lab_cases")
    .select("id")
    .ilike("patient_email", currentEmailLower)
    .is("deleted_at", null);
  if (fetchErr) return { ok: false, error: fetchErr.message };
  const caseIds = ((affected ?? []) as Array<{ id: string }>).map((r) => r.id);

  let casesUpdated = 0;
  if (caseIds.length > 0) {
    const { error: updErr } = await db
      .from("lab_cases")
      .update(update)
      .in("id", caseIds);
    if (updErr) return { ok: false, error: updErr.message };
    casesUpdated = caseIds.length;

    // One audit event per case so the activity log reflects the bulk edit.
    const noteParts: string[] = [];
    if (parsed.data.name !== undefined) noteParts.push(`name → "${parsed.data.name}"`);
    if (parsed.data.email !== undefined) noteParts.push(`email → ${parsed.data.email}`);
    if (parsed.data.phone !== undefined)
      noteParts.push(`phone → ${parsed.data.phone ?? "(none)"}`);
    if (parsed.data.dobIso !== undefined)
      noteParts.push(`dob → ${parsed.data.dobIso ?? "(none)"}`);
    const note = `Patient updated across cases: ${noteParts.join(", ")}`;
    await db.from("lab_events").insert(
      caseIds.map((id) => ({
        case_id: id,
        kind: "case_edited" as const,
        actor: user.email ?? "admin",
        note,
      })),
    );
  }

  // Mirror into patients_seed when one or more rows match the old email.
  // Composite key is (email, patient_name) so we update by email alone and
  // let Postgres handle the new constraint via the update set.
  let seedUpdated = 0;
  const seedUpdate: Record<string, string | null> = {};
  if (parsed.data.name !== undefined) seedUpdate.patient_name = parsed.data.name;
  if (parsed.data.email !== undefined)
    seedUpdate.email = parsed.data.email.toLowerCase();
  if (parsed.data.phone !== undefined) seedUpdate.phone = parsed.data.phone;
  if (parsed.data.dobIso !== undefined) seedUpdate.dob = parsed.data.dobIso;
  if (Object.keys(seedUpdate).length > 0) {
    const { data: seedMatched, error: seedErr } = await db
      .from("patients_seed")
      .update(seedUpdate)
      .eq("email", currentEmailLower)
      .select("id");
    if (!seedErr && seedMatched) {
      seedUpdated = seedMatched.length;
    }
  }

  revalidatePath("/labs");
  return { ok: true, data: { casesUpdated, seedUpdated } };
}

/** One row per unique patient_email (case-insensitive grouping), with case
 * counts and most-recent activity. */
export async function listPatients(opts?: {
  q?: string;
}): Promise<PatientSummary[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  let query = db
    .from("lab_cases")
    .select(
      "patient_email, patient_name, patient_phone, archived_at, deleted_at, updated_at",
    );
  const q = opts?.q?.trim();
  if (q) {
    const safe = q.replace(/[*,()]/g, "");
    const pattern = `*${safe}*`;
    query = query.or(
      [
        `patient_name.ilike.${pattern}`,
        `patient_email.ilike.${pattern}`,
      ].join(","),
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  type Row = {
    patient_email: string;
    patient_name: string;
    patient_phone: string | null;
    archived_at: string | null;
    deleted_at: string | null;
    updated_at: string;
  };
  const groups = new Map<string, PatientSummary>();
  for (const row of (data ?? []) as Row[]) {
    const key = row.patient_email.toLowerCase();
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        patient_email: row.patient_email,
        patient_name: row.patient_name,
        patient_phone: row.patient_phone,
        case_count: 1,
        active_count: !row.archived_at && !row.deleted_at ? 1 : 0,
        archived_count: row.archived_at && !row.deleted_at ? 1 : 0,
        deleted_count: row.deleted_at ? 1 : 0,
        last_activity_at: row.updated_at,
      });
    } else {
      existing.case_count += 1;
      if (!row.archived_at && !row.deleted_at) existing.active_count += 1;
      else if (row.archived_at && !row.deleted_at) existing.archived_count += 1;
      else if (row.deleted_at) existing.deleted_count += 1;
      if (row.updated_at > existing.last_activity_at) {
        existing.last_activity_at = row.updated_at;
      }
      if (!existing.patient_phone && row.patient_phone) {
        existing.patient_phone = row.patient_phone;
      }
    }
  }
  return [...groups.values()].sort((a, b) =>
    b.last_activity_at.localeCompare(a.last_activity_at),
  );
}

export type PatientHistory = {
  email: string;
  cases: LabCase[];
  events: LabEvent[];
  emailLogs: Array<{
    id: string;
    case_id: string;
    kind: string;
    status: string;
    to_address: string;
    error_message: string | null;
    resend_message_id: string | null;
    created_at: string;
  }>;
};

export type ReportData = {
  totals: {
    total: number;
    active: number;
    archived: number;
    deleted: number;
  };
  columnCounts: Record<string, number>;
  emailStats: { sent: number; failed: number; skipped: number };
  byLab: Array<{ lab_name: string; count: number }>;
  recentSendsByDay: Array<{ day: string; sent: number; failed: number }>;
};

export async function getReportData(): Promise<ReportData> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: caseRows, error: caseErr } = await db
    .from("lab_cases")
    .select("*");
  if (caseErr) throw new Error(caseErr.message);
  const cases = (caseRows ?? []) as LabCase[];

  const { data: logRows, error: logErr } = await db
    .from("email_logs")
    .select("status, created_at");
  if (logErr) throw new Error(logErr.message);
  const logs = (logRows ?? []) as Array<{ status: string; created_at: string }>;

  const totals = {
    total: cases.length,
    active: cases.filter((c) => !c.archived_at && !c.deleted_at).length,
    archived: cases.filter((c) => c.archived_at && !c.deleted_at).length,
    deleted: cases.filter((c) => c.deleted_at).length,
  };

  const { getColumnFor } = await import("@/lib/columns");
  const columnCounts: Record<string, number> = {};
  for (const c of cases) {
    if (c.archived_at || c.deleted_at) continue;
    const col = getColumnFor(c);
    columnCounts[col] = (columnCounts[col] ?? 0) + 1;
  }

  const emailStats = {
    sent: logs.filter((l) => l.status === "sent").length,
    failed: logs.filter((l) => l.status === "failed").length,
    skipped: logs.filter((l) => l.status === "skipped").length,
  };

  const labMap = new Map<string, number>();
  for (const c of cases) {
    if (c.deleted_at) continue;
    labMap.set(c.lab_name, (labMap.get(c.lab_name) ?? 0) + 1);
  }
  const byLab = [...labMap.entries()]
    .map(([lab_name, count]) => ({ lab_name, count }))
    .sort((a, b) => b.count - a.count);

  // Last 14 days of email activity, bucketed by day.
  const dayMap = new Map<string, { sent: number; failed: number }>();
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { sent: 0, failed: 0 });
  }
  for (const log of logs) {
    const key = log.created_at.slice(0, 10);
    const bucket = dayMap.get(key);
    if (!bucket) continue;
    if (log.status === "sent") bucket.sent += 1;
    else if (log.status === "failed") bucket.failed += 1;
  }
  const recentSendsByDay = [...dayMap.entries()].map(([day, v]) => ({
    day,
    ...v,
  }));

  return { totals, columnCounts, emailStats, byLab, recentSendsByDay };
}

export async function getPatientHistory(
  email: string,
): Promise<PatientHistory | null> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data: cases, error: caseErr } = await db
    .from("lab_cases")
    .select("*")
    .ilike("patient_email", email)
    .order("created_at", { ascending: false });
  if (caseErr) throw new Error(caseErr.message);
  const caseList = (cases ?? []) as LabCase[];
  if (caseList.length === 0) return null;
  const ids = caseList.map((c) => c.id);

  const [eventsRes, logsRes] = await Promise.all([
    db
      .from("lab_events")
      .select("*")
      .in("case_id", ids)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("email_logs")
      .select("*")
      .in("case_id", ids)
      .order("created_at", { ascending: false }),
  ]);
  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (logsRes.error) throw new Error(logsRes.error.message);

  return {
    email: caseList[0].patient_email,
    cases: caseList,
    events: (eventsRes.data ?? []) as LabEvent[],
    emailLogs: (logsRes.data ?? []) as PatientHistory["emailLogs"],
  };
}

// ── Duplicate cleanup (backlog #4) ──────────────────────────────────────
// A genuine duplicate = ≥2 NON-deleted cases for the same patient + same lab +
// same panel (e.g. Zenoti re-created an appointment under a new id, leaving an
// active card next to the original/archived one). NOT the same as Vibrant
// Zoomer sub-panels (those share an accession but have DIFFERENT panels, so
// they never land in one group here). Read-only finder + a click-gated resolve
// that soft-deletes the extras (recoverable from Settings → Deleted).

export type DuplicateMember = {
  id: string;
  patientName: string;
  labLabel: string;
  collectionDate: string | null;
  tracking: string | null;
  columnLabel: string;
  archived: boolean;
  createdAt: string;
  stepsDone: number;
};
export type DuplicateGroup = {
  key: string;
  patientName: string;
  patientEmail: string;
  /** "high" when members share a tracking # or collection date (almost
   * certainly the same physical order); "review" when they differ (could be a
   * legitimate repeat of the same panel — eyeball the dates before merging). */
  confidence: "high" | "review";
  members: DuplicateMember[];
  /** Most-advanced member (furthest column, then most steps, then newest). */
  suggestedKeepId: string;
};

export async function findDuplicateGroups(): Promise<
  ActionResult<{ groups: DuplicateGroup[] }>
> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("lab_cases").select("*").is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  const cases = (data ?? []) as LabCase[];

  const { getColumnFor, COLUMN_LABEL, completedStepCount } = await import("@/lib/columns");
  const { labelForCase } = await import("@/lib/labs/label");

  const norm = (v: string | null) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  // CRITICAL: group on the EFFECTIVE label (labelForCase, which folds in
  // zenoti_service_name), NOT raw lab_name/lab_panel. Zenoti multi-panel tests
  // store lab_name="Vibrant", lab_panel=null and keep the panel in
  // zenoti_service_name — so Foundational/Gut/Toxin share lab_name+lab_panel but
  // are DIFFERENT panels. Grouping on raw columns would lump them and offer to
  // delete real labs. The discriminator (same tracking # = same shipment, else
  // same collection_date = same draw day) keeps legitimately-separate orders of
  // the same panel apart; cases with NEITHER are never grouped.
  const discriminator = (c: LabCase) => c.tracking_number?.trim() || c.collection_date || null;
  const groupKey = (c: LabCase) => {
    const disc = discriminator(c);
    if (!disc) return `solo:${c.id}`; // unique → never groups
    return `${norm(c.patient_email)}|${norm(labelForCase(c))}|${disc}`;
  };

  const buckets = new Map<string, LabCase[]>();
  for (const c of cases) {
    const k = groupKey(c);
    const arr = buckets.get(k) ?? [];
    arr.push(c);
    buckets.set(k, arr);
  }

  // Keeper = the most COMPLETE record: most workflow steps done dominates (a
  // 9-step Protocol-received case beats a 1-step phantom that merely got
  // archived). Archived breaks ties (it's the already-filed copy), then newest.
  // NOT column index — "Completed" (archived) is a bucket, not progress.
  const rank = (c: LabCase) => completedStepCount(c) * 10 + (c.archived_at ? 1 : 0);

  const groups: DuplicateGroup[] = [];
  for (const [key, members] of buckets) {
    if (key.startsWith("solo:") || members.length < 2) continue;
    // Grouped by a shared tracking # (same physical shipment) → high confidence;
    // grouped only by collection date (no tracking) → review.
    const confidence: "high" | "review" = members[0].tracking_number?.trim() ? "high" : "review";

    const sorted = [...members].sort(
      (a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at),
    );
    groups.push({
      key,
      patientName: members[0].patient_name,
      patientEmail: members[0].patient_email,
      confidence,
      suggestedKeepId: sorted[0].id,
      members: sorted.map((c) => ({
        id: c.id,
        patientName: c.patient_name,
        labLabel: labelForCase(c),
        collectionDate: c.collection_date,
        tracking: c.tracking_number,
        columnLabel: COLUMN_LABEL[getColumnFor(c)],
        archived: Boolean(c.archived_at),
        createdAt: c.created_at,
        stepsDone: completedStepCount(c),
      })),
    });
  }
  // High-confidence first, then most members.
  groups.sort(
    (a, b) =>
      Number(b.confidence === "high") - Number(a.confidence === "high") ||
      b.members.length - a.members.length,
  );
  return { ok: true, data: { groups } };
}

/** Soft-delete the chosen duplicate rows, keeping `keepId`. Recoverable from
 * Settings → Deleted. Click-gated from the Duplicates panel — never automatic. */
export async function resolveDuplicates(input: {
  keepId: string;
  removeIds: string[];
}): Promise<ActionResult<{ removed: number }>> {
  const user = await requireSignedIn();
  const removeIds = [...new Set(input.removeIds)].filter((id) => id && id !== input.keepId);
  if (removeIds.length === 0) return { ok: false, error: "Select at least one duplicate to remove." };
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", removeIds)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const removed = (data ?? []).map((d) => (d as { id: string }).id);
  if (removed.length > 0) {
    await db.from("lab_events").insert(
      removed.map((id) => ({
        case_id: id,
        kind: "case_deleted" as const,
        actor: user.email ?? "admin",
        note: `Removed as duplicate — kept case ${input.keepId}. Recoverable from Settings → Deleted.`,
        meta: { duplicate_of: input.keepId },
      })),
    );
  }
  revalidatePath("/labs");
  return { ok: true, data: { removed: removed.length } };
}
