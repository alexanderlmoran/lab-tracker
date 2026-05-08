"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult, LabCase, LabEvent, StepNumber } from "@/lib/types";

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
    partial_expected: p.partialExpected,
    auto_send_emails: p.autoSendEmails,
    notes: p.notes,
  };
}

export async function createLabCase(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireAdmin();
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

export async function updateLabCase(
  caseId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireAdmin();
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
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next)) {
    const prev = (current as Record<string, unknown>)[k];
    if (prev !== v) changes[k] = { from: prev, to: v };
  }

  if (Object.keys(changes).length === 0) {
    return { ok: true };
  }

  const { error: updateErr } = await db
    .from("lab_cases")
    .update(next)
    .eq("id", caseId);

  if (updateErr) return { ok: false, error: updateErr.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    meta: { changes },
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

async function setArchive(
  caseId: string,
  archived: boolean,
): Promise<ActionResult> {
  const user = await requireAdmin();
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
  return { ok: true };
}

export async function archiveLabCase(caseId: string): Promise<ActionResult> {
  return setArchive(caseId, true);
}

export async function unarchiveLabCase(caseId: string): Promise<ActionResult> {
  return setArchive(caseId, false);
}

async function setDeleted(
  caseId: string,
  deleted: boolean,
): Promise<ActionResult> {
  const user = await requireAdmin();
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
  const user = await requireAdmin();
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
  const user = await requireAdmin();
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

export async function bulkDelete(input: {
  caseIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const user = await requireAdmin();
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
  return { ok: true, data: { count: parsed.data.caseIds.length } };
}

const StepToggleInput = z.object({
  caseId: z.string().uuid(),
  step: z.number().int().min(1).max(9),
  completed: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export async function setStepCompleted(input: {
  caseId: string;
  step: number;
  completed: boolean;
  note?: string;
}): Promise<ActionResult> {
  const user = await requireAdmin();
  const parsed = StepToggleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, step, completed, note } = parsed.data;
  const stepNum = step as StepNumber;
  const dbCol = STEP_TO_DB_COL[stepNum];

  const db = getSupabaseAdmin();

  const { error: updateErr } = await db
    .from("lab_cases")
    .update({ [dbCol]: completed })
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

  // Auto-push to PracticeBetter when final results are marked uploaded.
  // Best-effort: a PB failure must not block the step toggle.
  if (completed && step === 5) {
    try {
      const { pushLabToPracticeBetter } = await import("./practicebetter-actions");
      await pushLabToPracticeBetter({ caseId, kind: "complete" });
    } catch (err) {
      console.error("[practicebetter] auto-push failed", err);
    }
  }

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

export async function listLabEvents(caseId: string): Promise<LabEvent[]> {
  await requireAdmin();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_events")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as LabEvent[];
}

export async function getLabCase(caseId: string): Promise<LabCase | null> {
  await requireAdmin();
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
  /** Free-text query — matches patient_name, patient_email, tracking_number. */
  q?: string;
  /** Exact lab_name match. */
  lab?: string;
};

function escapePostgrestPattern(s: string): string {
  // PostgREST `ilike` uses `*` as wildcard. Strip user `*` so they don't
  // inject their own pattern, and escape commas/parens which terminate the
  // filter expression.
  return s.replace(/[*,()]/g, "");
}

export async function listLabCases(opts: {
  view?: LabCaseView;
  filters?: LabCaseFilters;
  /** @deprecated use `view`. Retained so older call sites keep compiling. */
  archived?: boolean;
}): Promise<LabCase[]> {
  await requireAdmin();
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
    const pattern = `*${escapePostgrestPattern(q)}*`;
    filtered = filtered.or(
      [
        `patient_name.ilike.${pattern}`,
        `patient_email.ilike.${pattern}`,
        `tracking_number.ilike.${pattern}`,
      ].join(","),
    );
  }

  const lab = opts.filters?.lab?.trim();
  if (lab) {
    filtered = filtered.eq("lab_name", lab);
  }

  const { data, error } = await filtered.order("created_at", {
    ascending: false,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as LabCase[];
}

/** Distinct lab names across non-deleted cases — for the filter dropdown. */
export async function listDistinctLabNames(): Promise<string[]> {
  await requireAdmin();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("lab_name")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  const names = new Set<string>();
  for (const row of (data ?? []) as Array<{ lab_name: string }>) {
    if (row.lab_name) names.add(row.lab_name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
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

/** One row per unique patient_email (case-insensitive grouping), with case
 * counts and most-recent activity. */
export async function listPatients(opts?: {
  q?: string;
}): Promise<PatientSummary[]> {
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
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
