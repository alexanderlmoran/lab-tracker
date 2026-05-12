"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";
import type { ImportDraft } from "@/lib/labs/import-normalize";

/**
 * Patient match outcome attached to a draft. "exact_one" — single PB record
 * matched on full name; safe to auto-fill. "ambiguous" — multiple records
 * matched and the operator must pick one. "none" — no PB match; operator
 * enters email manually.
 */
export type PatientMatchKind = "exact_one" | "ambiguous" | "none";

// PBSuggestion is kept as a name for back-compat with ImportClient.tsx, but
// it now describes a past patient pulled from lab_cases rather than the
// PracticeBetter cache (PB integration abandoned 2026-05-11). `recordId`
// is the patient_email lowercased — used as the dedup key in the picker.
export type PBSuggestion = {
  recordId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  dobIso: string | null;
};

export type EnrichedDraft = ImportDraft & {
  matchKind: PatientMatchKind;
  /** When ambiguous, the candidates the operator can choose from. */
  candidates: PBSuggestion[];
};

type PastCaseRow = {
  patient_name: string;
  patient_email: string;
  patient_phone: string | null;
  patient_dob: string | null;
};

function rowToSuggestion(r: PastCaseRow): PBSuggestion {
  const parts = r.patient_name.trim().split(/\s+/);
  return {
    recordId: r.patient_email.toLowerCase(),
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts[parts.length - 1] : null,
    email: r.patient_email,
    phone: r.patient_phone,
    dobIso: r.patient_dob,
  };
}

function tokenize(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * Match a free-text patient name against the PB cache. Strategy:
 *
 *   1. Split into first + last token.
 *   2. ILIKE on (first_name starts with first AND last_name starts with last).
 *   3. If exactly one row → exact_one.
 *   4. If multiple → ambiguous.
 *   5. If zero, fall back to last-name-only ILIKE; treat any results as ambiguous
 *      so the operator can confirm.
 */
async function matchPatientToCache(
  name: string,
): Promise<{ kind: PatientMatchKind; candidates: PBSuggestion[] }> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return { kind: "none", candidates: [] };
  const db = getSupabaseAdmin();
  const { first, last } = tokenize(trimmed);
  const safe = trimmed.replace(/[%_,()]/g, " ");

  // Search past patients in our own lab_cases table. Dedupe by email so the
  // same patient with N prior cases shows up once. Preference order:
  //   1. first + last both match (anywhere in patient_name)
  //   2. last name only
  //   3. raw substring of the entered text
  const { data, error } = await db
    .from("lab_cases")
    .select("patient_name, patient_email, patient_phone, patient_dob, updated_at")
    .ilike("patient_name", `%${safe}%`)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error || !data) return { kind: "none", candidates: [] };

  const byEmail = new Map<string, PastCaseRow>();
  for (const r of data as PastCaseRow[]) {
    const key = r.patient_email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, r);
  }
  const candidates = [...byEmail.values()].map(rowToSuggestion);
  if (candidates.length === 0) {
    // Last-resort: last name only — useful when CSV row has a typo'd first.
    const fallback = last || first;
    if (!fallback) return { kind: "none", candidates: [] };
    const { data: fbData } = await db
      .from("lab_cases")
      .select("patient_name, patient_email, patient_phone, patient_dob, updated_at")
      .ilike("patient_name", `%${fallback}%`)
      .order("updated_at", { ascending: false })
      .limit(20);
    if (!fbData || fbData.length === 0) return { kind: "none", candidates: [] };
    const fbBy = new Map<string, PastCaseRow>();
    for (const r of fbData as PastCaseRow[]) {
      const key = r.patient_email.toLowerCase();
      if (!fbBy.has(key)) fbBy.set(key, r);
    }
    return {
      kind: "ambiguous",
      candidates: [...fbBy.values()].map(rowToSuggestion),
    };
  }
  if (candidates.length === 1) return { kind: "exact_one", candidates };
  return { kind: "ambiguous", candidates };
}

/**
 * Server-side enrichment: runs the PB cache match for every draft. Called
 * once after CSV parse. Returns the same draft list with patient fields
 * filled in for `exact_one` matches and candidates attached for `ambiguous`.
 */
export async function enrichImportDrafts(
  drafts: ImportDraft[],
): Promise<ActionResult<EnrichedDraft[]>> {
  await requireSignedIn();
  const enriched: EnrichedDraft[] = [];
  for (const d of drafts) {
    if (d.skipReason) {
      enriched.push({ ...d, matchKind: "none", candidates: [] });
      continue;
    }
    const m = await matchPatientToCache(d.patientName);
    if (m.kind === "exact_one") {
      const c = m.candidates[0];
      enriched.push({
        ...d,
        patientEmail: c.email ?? d.patientEmail,
        patientPhone: c.phone ?? d.patientPhone,
        patientDobIso: c.dobIso ?? d.patientDobIso,
        matchKind: "exact_one",
        candidates: m.candidates,
        warning: d.warning,
      });
    } else {
      enriched.push({
        ...d,
        matchKind: m.kind,
        candidates: m.candidates,
        warning:
          m.kind === "none"
            ? d.warning ?? "No past patient match — enter email manually"
            : (d.warning ?? "Multiple matches — pick one"),
      });
    }
  }
  return { ok: true, data: enriched };
}

const CommitInput = z.object({
  bulkImportId: z.string().uuid(),
  rows: z.array(
    z.object({
      patientName: z.string().min(1).max(200),
      patientEmail: z.string().email().max(200),
      patientPhone: z.string().max(40).nullable(),
      patientDobIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      labName: z.string().min(1).max(100),
      labPanel: z.string().max(100).nullable(),
      trackingNumber: z.string().max(100).nullable(),
      sampleSentAtIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      expectedResultAtMinIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      expectedResultAtMaxIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      notes: z.string().max(2000).nullable(),
    }),
  ),
});

export type CommitImportResult = {
  bulkImportId: string;
  insertedCount: number;
  failed: { patientName: string; reason: string }[];
};

/**
 * Insert all accepted rows as new lab_cases with step1_sample_sent = true,
 * stamped with the same bulk_import_id so the import can be rolled back as
 * a unit. Audit row written per case.
 */
export async function commitImport(input: {
  bulkImportId: string;
  rows: Array<{
    patientName: string;
    patientEmail: string;
    patientPhone: string | null;
    patientDobIso: string | null;
    labName: string;
    labPanel: string | null;
    trackingNumber: string | null;
    sampleSentAtIso: string | null;
    expectedResultAtMinIso: string | null;
    expectedResultAtMaxIso: string | null;
    notes: string | null;
  }>;
}): Promise<ActionResult<CommitImportResult>> {
  const user = await requireSignedIn();
  const parsed = CommitInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const failed: { patientName: string; reason: string }[] = [];
  let inserted = 0;

  // Per-row insert so a single bad row (constraint, etc.) doesn't abort the
  // whole batch. Throughput is not a concern at <500 rows.
  for (const r of parsed.data.rows) {
    const { data, error } = await db
      .from("lab_cases")
      .insert({
        patient_name: r.patientName,
        patient_email: r.patientEmail,
        patient_phone: r.patientPhone,
        patient_dob: r.patientDobIso,
        lab_name: r.labName,
        lab_panel: r.labPanel,
        tracking_number: r.trackingNumber,
        notes: r.notes,
        step1_sample_sent: true,
        bulk_import_id: parsed.data.bulkImportId,
        expected_result_at_min: r.expectedResultAtMinIso,
        expected_result_at_max: r.expectedResultAtMaxIso,
      })
      .select("id")
      .single();

    if (error || !data) {
      failed.push({
        patientName: r.patientName,
        reason: error?.message ?? "Insert failed",
      });
      continue;
    }

    inserted++;

    // Audit: bulk-import + step-1 already-set + expected-dates if any.
    await db.from("lab_events").insert([
      {
        case_id: data.id,
        kind: "case_bulk_imported",
        actor: user.email ?? "admin",
        note: `bulk_import_id=${parsed.data.bulkImportId}`,
      },
      {
        case_id: data.id,
        kind: "step_toggled",
        step: 1,
        completed: true,
        actor: user.email ?? "admin",
        note: r.sampleSentAtIso ? `Sample sent on ${r.sampleSentAtIso}` : null,
      },
    ]);
    if (r.expectedResultAtMinIso || r.expectedResultAtMaxIso) {
      await db.from("lab_events").insert({
        case_id: data.id,
        kind: "expected_dates_set",
        actor: user.email ?? "admin",
        note: `Predicted: ${r.expectedResultAtMinIso ?? "—"} to ${r.expectedResultAtMaxIso ?? "—"}`,
      });
    }
  }

  revalidatePath("/labs");

  return {
    ok: true,
    data: {
      bulkImportId: parsed.data.bulkImportId,
      insertedCount: inserted,
      failed,
    },
  };
}

/**
 * Roll back an import — delete every case stamped with the given
 * bulk_import_id. Used as the "undo" button after a botched import.
 * Soft-delete via deleted_at (not hard-delete) so audit trail survives.
 */
export async function rollbackImport(
  bulkImportId: string,
): Promise<ActionResult<{ deletedCount: number }>> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .update({ deleted_at: new Date().toISOString() })
    .eq("bulk_import_id", bulkImportId)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs");
  return { ok: true, data: { deletedCount: data?.length ?? 0 } };
}

export type RecentImport = {
  bulkImportId: string;
  caseCount: number;
  importedAtIso: string;
};

/**
 * Recent imports for the rollback UI. Groups active (non-deleted) cases by
 * `bulk_import_id`, returns the most recent 10. Cheap because the kanban
 * dataset is bounded; client-side grouping avoids needing a Postgres RPC.
 */
export async function listRecentImports(): Promise<ActionResult<RecentImport[]>> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("bulk_import_id, created_at")
    .not("bulk_import_id", "is", null)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  const groups = new Map<string, { count: number; earliest: string }>();
  for (const r of (data ?? []) as { bulk_import_id: string | null; created_at: string }[]) {
    if (!r.bulk_import_id) continue;
    const g = groups.get(r.bulk_import_id);
    if (!g) {
      groups.set(r.bulk_import_id, { count: 1, earliest: r.created_at });
    } else {
      g.count += 1;
      if (r.created_at < g.earliest) g.earliest = r.created_at;
    }
  }

  const list: RecentImport[] = [...groups.entries()].map(([id, g]) => ({
    bulkImportId: id,
    caseCount: g.count,
    importedAtIso: g.earliest,
  }));
  list.sort((a, b) => b.importedAtIso.localeCompare(a.importedAtIso));
  return { ok: true, data: list.slice(0, 10) };
}
