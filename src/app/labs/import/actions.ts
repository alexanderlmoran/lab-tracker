"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";
import type { ImportDraft } from "@/lib/labs/import-normalize";
import {
  aiNormalizeDrafts,
  type NormalizeResult,
} from "@/lib/ai/normalize-import";
import { listEffectiveLabs } from "@/lib/labs/effective";
import { getLabAliasPairs } from "@/lib/labs/catalog";
import { listSeededPatients } from "@/lib/labs/patients-seed";

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

  // Search past patients in our own lab_cases table AND the patients_seed
  // table in parallel. lab_cases is the live source of truth; patients_seed
  // is the operator-curated import (PB export, Zenoti list) for people who
  // haven't yet had a case in our DB. Dedupe by email so the same patient
  // appearing in both surfaces once.
  const [casesRes, seedRes] = await Promise.all([
    db
      .from("lab_cases")
      .select("patient_name, patient_email, patient_phone, patient_dob, updated_at")
      .ilike("patient_name", `%${safe}%`)
      .order("updated_at", { ascending: false })
      .limit(50),
    db
      .from("patients_seed")
      .select("patient_name, email, phone, dob")
      .ilike("patient_name", `%${safe}%`)
      .limit(50),
  ]);
  if (casesRes.error && seedRes.error) return { kind: "none", candidates: [] };

  const byEmail = new Map<string, PastCaseRow>();
  for (const r of (casesRes.data ?? []) as PastCaseRow[]) {
    const key = r.patient_email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, r);
  }
  for (const r of (seedRes.data ?? []) as Array<{
    patient_name: string;
    email: string;
    phone: string | null;
    dob: string | null;
  }>) {
    const key = r.email.toLowerCase();
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        patient_name: r.patient_name,
        patient_email: r.email,
        patient_phone: r.phone,
        patient_dob: r.dob,
      });
    }
  }
  const candidates = [...byEmail.values()].map(rowToSuggestion);
  if (candidates.length === 0) {
    // Last-resort: last name only — useful when CSV row has a typo'd first.
    // Same dual-source search as the primary pass.
    const fallback = last || first;
    if (!fallback) return { kind: "none", candidates: [] };
    const [fbCases, fbSeed] = await Promise.all([
      db
        .from("lab_cases")
        .select("patient_name, patient_email, patient_phone, patient_dob, updated_at")
        .ilike("patient_name", `%${fallback}%`)
        .order("updated_at", { ascending: false })
        .limit(20),
      db
        .from("patients_seed")
        .select("patient_name, email, phone, dob")
        .ilike("patient_name", `%${fallback}%`)
        .limit(20),
    ]);
    const fbBy = new Map<string, PastCaseRow>();
    for (const r of (fbCases.data ?? []) as PastCaseRow[]) {
      const key = r.patient_email.toLowerCase();
      if (!fbBy.has(key)) fbBy.set(key, r);
    }
    for (const r of (fbSeed.data ?? []) as Array<{
      patient_name: string;
      email: string;
      phone: string | null;
      dob: string | null;
    }>) {
      const key = r.email.toLowerCase();
      if (!fbBy.has(key)) {
        fbBy.set(key, {
          patient_name: r.patient_name,
          patient_email: r.email,
          patient_phone: r.phone,
          patient_dob: r.dob,
        });
      }
    }
    if (fbBy.size === 0) return { kind: "none", candidates: [] };
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

/**
 * AI normalization pass — fuzzy-matches each draft's raw lab/patient name
 * against the canonical lists. Single batched Claude call per upload.
 *
 * Returns one result per draft. Callers auto-apply suggestions with
 * confidence >= 0.9 and surface the rest as low-confidence flags so the
 * operator can review before commit.
 */
export type AiNormalizeRow = NormalizeResult & {
  /** Whether the suggestion was auto-applied client-side. Set by the caller
   * after thresholding so the UI badge reflects truth. We just pass through
   * raw model output here. */
  autoApplied?: boolean;
};

export async function aiNormalizeImportDrafts(input: {
  drafts: Array<{
    draftKey: string;
    rawLab: string;
    patientName: string;
  }>;
  /** Free-text context from the CSV (legend lines, comment columns) so the
   * model can cross-reference annotations across rows. */
  csvContext?: string;
}): Promise<ActionResult<NormalizeResult[]>> {
  await requireSignedIn();
  if (input.drafts.length === 0) return { ok: true, data: [] };

  const db = getSupabaseAdmin();

  // Canonical labs from the effective catalog (DB overrides + code fallback).
  let knownLabs: string[] = [];
  try {
    const labs = await listEffectiveLabs();
    knownLabs = Array.from(new Set(labs.map((l) => l.provider))).filter(Boolean);
  } catch {
    knownLabs = [];
  }

  // Known patients for the AI fuzzy-match: union of recent lab_cases rows
  // (most recent 500) AND the operator-curated patients_seed list. The seed
  // adds people who exist in PB/Zenoti but haven't had a case yet —
  // critical for the very first import after they're added.
  let knownPatients: string[] = [];
  try {
    const { data } = await db
      .from("lab_cases")
      .select("patient_name, updated_at")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(500);
    const seen = new Set<string>();
    for (const r of (data ?? []) as Array<{ patient_name: string }>) {
      const n = r.patient_name?.trim();
      if (n && !seen.has(n.toLowerCase())) {
        seen.add(n.toLowerCase());
        knownPatients.push(n);
      }
    }
    const seeded = await listSeededPatients();
    for (const s of seeded) {
      const key = s.patientName.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        knownPatients.push(s.patientName);
      }
    }
  } catch {
    knownPatients = [];
  }

  try {
    const results = await aiNormalizeDrafts({
      rows: input.drafts.map((d) => ({
        rowKey: d.draftKey,
        rawLab: d.rawLab,
        rawPatient: d.patientName,
      })),
      knownLabs,
      knownPatients,
      labAliases: getLabAliasPairs(),
      csvContext: input.csvContext,
    });
    return { ok: true, data: results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    return { ok: false, error: msg };
  }
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
      // When true, server-side dup detection won't skip this row even if it
      // matches an existing case. Set by the operator's Import-anyway choice
      // in the preview screen.
      forceImport: z.boolean().optional(),
    }),
  ),
});

export type DuplicateMatch =
  | { kind: "none" }
  | {
      kind: "exact";
      matchedOn: "tracking_number" | "patient_email+lab+date";
      existingCaseId: string;
    }
  | {
      kind: "similar";
      matchedOn: "patient_email+lab+panel";
      existingCaseId: string;
      existingCollectionDate: string | null;
    };

const DupCheckInput = z.object({
  rows: z.array(
    z.object({
      patientEmail: z.string().email().max(200),
      labName: z.string().min(1).max(100),
      labPanel: z.string().max(100).nullable(),
      trackingNumber: z.string().max(100).nullable(),
      sampleSentAtIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }),
  ),
});

/**
 * Classify each candidate row as none / exact-duplicate / similar-duplicate
 * against the existing (non-deleted) lab_cases. Used by the import preview
 * to flag dupes before commit so the operator can pick Skip / Import-anyway
 * per row or in bulk.
 *
 *   exact   — same tracking number, OR same (email + lab + collection_date).
 *             Almost certainly the same shipment being re-imported.
 *   similar — same (email + lab + panel) but different/missing date. Could
 *             be a legitimate re-order; surfaces for operator review.
 *   none    — no overlap.
 */
export async function checkImportDuplicates(input: {
  rows: Array<{
    patientEmail: string;
    labName: string;
    labPanel: string | null;
    trackingNumber: string | null;
    sampleSentAtIso: string | null;
  }>;
}): Promise<ActionResult<DuplicateMatch[]>> {
  await requireSignedIn();
  const parsed = DupCheckInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const rows = parsed.data.rows;
  const out: DuplicateMatch[] = rows.map(() => ({ kind: "none" }));

  // Pass 1 — tracking-number exact match.
  const tnPairs = rows
    .map((r, i) => ({ tn: r.trackingNumber, i }))
    .filter((x): x is { tn: string; i: number } => !!x.tn);
  if (tnPairs.length > 0) {
    const { data } = await db
      .from("lab_cases")
      .select("id, tracking_number")
      .in("tracking_number", tnPairs.map((x) => x.tn))
      .is("deleted_at", null);
    const byTn = new Map<string, string>();
    for (const r of (data ?? []) as Array<{ id: string; tracking_number: string | null }>) {
      if (r.tracking_number) byTn.set(r.tracking_number, r.id);
    }
    for (const { tn, i } of tnPairs) {
      const id = byTn.get(tn);
      if (id) {
        out[i] = { kind: "exact", matchedOn: "tracking_number", existingCaseId: id };
      }
    }
  }

  // Pass 2 — email+lab+date exact match, only for rows not already flagged.
  // Pass 3 — email+lab+panel similar match, only for rows still none.
  // Single per-row query; row counts are bounded (<500), and this avoids a
  // complex OR filter that PostgREST escapes awkwardly.
  for (let i = 0; i < rows.length; i++) {
    if (out[i].kind !== "none") continue;
    const r = rows[i];
    const emailNorm = r.patientEmail.trim().toLowerCase();
    let q = db
      .from("lab_cases")
      .select("id, collection_date, lab_panel")
      .ilike("patient_email", emailNorm)
      .eq("lab_name", r.labName)
      .is("deleted_at", null)
      .limit(5);
    const { data } = await q;
    const matches = (data ?? []) as Array<{
      id: string;
      collection_date: string | null;
      lab_panel: string | null;
    }>;
    if (matches.length === 0) continue;

    // Exact same date wins over panel-only.
    if (r.sampleSentAtIso) {
      const exact = matches.find((m) => m.collection_date === r.sampleSentAtIso);
      if (exact) {
        out[i] = {
          kind: "exact",
          matchedOn: "patient_email+lab+date",
          existingCaseId: exact.id,
        };
        continue;
      }
    }
    // Panel-aware similar match (or panel-less when both are null).
    const panelMatch = matches.find((m) => (m.lab_panel ?? null) === (r.labPanel ?? null));
    const pick = panelMatch ?? matches[0];
    out[i] = {
      kind: "similar",
      matchedOn: "patient_email+lab+panel",
      existingCaseId: pick.id,
      existingCollectionDate: pick.collection_date,
    };
  }

  return { ok: true, data: out };
}

export type CommitImportResult = {
  bulkImportId: string;
  insertedCount: number;
  failed: { patientName: string; reason: string }[];
  skippedDuplicates: {
    patientName: string;
    labName: string;
    matchedOn: "tracking_number" | "patient_email+lab+date";
  }[];
};

/**
 * A row already exists if EITHER:
 *   • same `tracking_number` (when present) — strongest unique key on shipments;
 *   • same patient_email + lab_name + collection_date — covers re-imports where
 *     the tracking number is missing.
 * We only look at non-deleted rows so previously-rolled-back imports re-import
 * cleanly.
 */
async function findDuplicates(
  db: ReturnType<typeof getSupabaseAdmin>,
  rows: Array<{
    patientEmail: string;
    labName: string;
    trackingNumber: string | null;
    sampleSentAtIso: string | null;
  }>,
): Promise<Set<number>> {
  const dup = new Set<number>();
  const trackingNumbers = rows
    .map((r, i) => ({ tn: r.trackingNumber, i }))
    .filter((x): x is { tn: string; i: number } => !!x.tn);
  if (trackingNumbers.length > 0) {
    const { data } = await db
      .from("lab_cases")
      .select("tracking_number")
      .in(
        "tracking_number",
        trackingNumbers.map((x) => x.tn),
      )
      .is("deleted_at", null);
    const have = new Set(
      ((data ?? []) as Array<{ tracking_number: string | null }>)
        .map((r) => r.tracking_number)
        .filter(Boolean) as string[],
    );
    for (const { tn, i } of trackingNumbers) {
      if (have.has(tn)) dup.add(i);
    }
  }
  // Fallback dedupe by (email + lab + date) only for rows not already flagged.
  for (let i = 0; i < rows.length; i++) {
    if (dup.has(i)) continue;
    const r = rows[i];
    if (!r.sampleSentAtIso) continue;
    const { data } = await db
      .from("lab_cases")
      .select("id")
      .eq("patient_email", r.patientEmail)
      .eq("lab_name", r.labName)
      .eq("collection_date", r.sampleSentAtIso)
      .is("deleted_at", null)
      .limit(1);
    if ((data ?? []).length > 0) dup.add(i);
  }
  return dup;
}

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
    forceImport?: boolean;
  }>;
}): Promise<ActionResult<CommitImportResult>> {
  const user = await requireSignedIn();
  const parsed = CommitInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const failed: { patientName: string; reason: string }[] = [];
  const skippedDuplicates: CommitImportResult["skippedDuplicates"] = [];
  let inserted = 0;

  const dupIdx = await findDuplicates(db, parsed.data.rows);

  // Per-row insert so a single bad row (constraint, etc.) doesn't abort the
  // whole batch. Throughput is not a concern at <500 rows.
  for (let i = 0; i < parsed.data.rows.length; i++) {
    const r = parsed.data.rows[i];
    if (dupIdx.has(i) && !r.forceImport) {
      skippedDuplicates.push({
        patientName: r.patientName,
        labName: r.labName,
        matchedOn: r.trackingNumber
          ? "tracking_number"
          : "patient_email+lab+date",
      });
      continue;
    }
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
        collection_date: r.sampleSentAtIso,
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
      skippedDuplicates,
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
