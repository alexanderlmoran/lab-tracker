"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guard";
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

type CachedRow = {
  record_id: string;
  first_name: string | null;
  last_name: string | null;
  email_lowered: string | null;
  raw: unknown;
};

function pickFromRaw(raw: unknown): { phone: string | null; dobIso: string | null } {
  if (!raw || typeof raw !== "object") return { phone: null, dobIso: null };
  const r = raw as Record<string, unknown>;
  const profile = (r.profile ?? {}) as Record<string, unknown>;
  const client = (r.client ?? {}) as Record<string, unknown>;
  const phone =
    (typeof profile.phoneNumber === "string" && profile.phoneNumber) ||
    (typeof profile.cellPhone === "string" && profile.cellPhone) ||
    (typeof profile.homePhone === "string" && profile.homePhone) ||
    (typeof client.phoneNumber === "string" && client.phoneNumber) ||
    null;
  const rawDob =
    (typeof profile.dateOfBirth === "string" && profile.dateOfBirth) ||
    (typeof profile.dob === "string" && profile.dob) ||
    null;
  let dobIso: string | null = null;
  if (rawDob) {
    if (/^\d{4}-\d{2}-\d{2}/.test(rawDob)) dobIso = rawDob.slice(0, 10);
    else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDob)) {
      const [m, d, y] = rawDob.split(" ")[0].split("/");
      dobIso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  return { phone: phone || null, dobIso };
}

function rowToSuggestion(r: CachedRow): PBSuggestion {
  const { phone, dobIso } = pickFromRaw(r.raw);
  return {
    recordId: r.record_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email_lowered,
    phone,
    dobIso,
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

  if (first && last) {
    const { data, error } = await db
      .from("practicebetter_clients")
      .select("record_id, first_name, last_name, email_lowered, raw")
      .eq("is_child_record", false)
      .ilike("first_name", `${first}%`)
      .ilike("last_name", `${last}%`)
      .limit(8);
    if (!error && data && data.length === 1) {
      return { kind: "exact_one", candidates: [rowToSuggestion(data[0] as CachedRow)] };
    }
    if (!error && data && data.length > 1) {
      return { kind: "ambiguous", candidates: (data as CachedRow[]).map(rowToSuggestion) };
    }
  }

  // Fallback: last-name only (handles "Smith" alone or first-name typos).
  const fallbackTerm = last || first;
  if (!fallbackTerm) return { kind: "none", candidates: [] };
  const { data: fbData, error: fbErr } = await db
    .from("practicebetter_clients")
    .select("record_id, first_name, last_name, email_lowered, raw")
    .eq("is_child_record", false)
    .ilike("last_name", `${fallbackTerm}%`)
    .limit(8);
  if (fbErr || !fbData || fbData.length === 0) {
    return { kind: "none", candidates: [] };
  }
  return {
    kind: fbData.length === 1 ? "ambiguous" : "ambiguous",
    candidates: (fbData as CachedRow[]).map(rowToSuggestion),
  };
}

/**
 * Server-side enrichment: runs the PB cache match for every draft. Called
 * once after CSV parse. Returns the same draft list with patient fields
 * filled in for `exact_one` matches and candidates attached for `ambiguous`.
 */
export async function enrichImportDrafts(
  drafts: ImportDraft[],
): Promise<ActionResult<EnrichedDraft[]>> {
  await requireAdmin();
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
        practiceBetterRecordId: c.recordId,
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
            ? d.warning ?? "No PB match — enter email manually"
            : (d.warning ?? "Multiple PB matches — pick one"),
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
      practiceBetterRecordId: z.string().max(100).nullable(),
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
    practiceBetterRecordId: string | null;
    labName: string;
    labPanel: string | null;
    trackingNumber: string | null;
    sampleSentAtIso: string | null;
    expectedResultAtMinIso: string | null;
    expectedResultAtMaxIso: string | null;
    notes: string | null;
  }>;
}): Promise<ActionResult<CommitImportResult>> {
  const user = await requireAdmin();
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
        practicebetter_record_id: r.practiceBetterRecordId,
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
  await requireAdmin();
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
  await requireAdmin();
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
