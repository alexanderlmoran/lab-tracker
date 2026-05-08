"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import {
  appendNotesToRecord,
  createRecord,
  findRecordByEmailWithDiagnostics,
  getRecordById,
  pbDumpFirstPage,
  pbHealthCheck,
  PracticeBetterError,
  probeWriteEndpoints,
} from "@/lib/practicebetter/client";
import {
  syncPracticeBetterClients,
  getLatestPracticeBetterSync,
} from "@/lib/practicebetter/sync";
import type {
  ActionResult,
  LabCase,
  PracticeBetterPushKind,
} from "@/lib/types";

const PushInput = z.object({
  caseId: z.string().uuid(),
  kind: z.enum(["partial", "complete", "manual"]),
  force: z.boolean().optional(),
});

function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = full.trim().replace(/\s+/g, " ");
  if (!trimmed) return { firstName: "Unknown", lastName: "Patient" };
  const parts = trimmed.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "—" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function buildNoteBlock(args: {
  caseRow: LabCase;
  kind: PracticeBetterPushKind;
  marker: string;
  pushedAt: string;
}): string {
  const { caseRow, kind, marker, pushedAt } = args;
  const labelByKind: Record<PracticeBetterPushKind, string> = {
    partial: "Lab — partial results",
    complete: "Lab — final results",
    manual: "Lab — manual upload",
  };
  const lines = [
    `── ${labelByKind[kind]} (${pushedAt.slice(0, 10)}) ──`,
    `Lab: ${caseRow.lab_name}${caseRow.lab_panel ? ` · ${caseRow.lab_panel}` : ""}`,
  ];
  if (caseRow.tracking_number) lines.push(`Tracking: ${caseRow.tracking_number}`);
  if (caseRow.notes) lines.push(`Notes: ${caseRow.notes}`);
  lines.push(`Source: lab-tracker case ${caseRow.id}`);
  lines.push(marker);
  return lines.join("\n");
}

export async function pushLabToPracticeBetter(input: {
  caseId: string;
  kind: PracticeBetterPushKind;
  force?: boolean;
}): Promise<
  ActionResult<{
    recordId: string;
    notesAppended: boolean;
    skippedReason?: string;
    createdNewRecord?: boolean;
    writeMethod?: "PATCH" | "PUT" | null;
    writeStatus?: number | null;
  }>
> {
  await requireAdmin();
  const parsed = PushInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, kind, force } = parsed.data;

  const db = getSupabaseAdmin();

  const { data: caseRowRaw } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  const caseRow = caseRowRaw as LabCase | null;
  if (!caseRow) return { ok: false, error: "Case not found" };

  const marker = `[lab-tracker:${kind}:${caseId}]`;

  // Insert/upsert audit row in 'queued' state. Unique (case_id, kind) means
  // a second invocation of the same kind reuses the row.
  const { data: existing } = await db
    .from("practicebetter_pushes")
    .select("id, status, record_id, succeeded_at")
    .eq("case_id", caseId)
    .eq("kind", kind)
    .maybeSingle();

  let pushId: string;
  if (existing?.id) {
    pushId = existing.id;
    if (existing.status === "sent" && !force) {
      return {
        ok: true,
        data: {
          recordId: existing.record_id ?? "",
          notesAppended: false,
          skippedReason: "already pushed",
        },
      };
    }
    await db
      .from("practicebetter_pushes")
      .update({
        status: "queued",
        attempted_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", pushId);
  } else {
    const { data: inserted, error: insertErr } = await db
      .from("practicebetter_pushes")
      .insert({
        case_id: caseId,
        kind,
        status: "queued",
        marker,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return { ok: false, error: insertErr?.message ?? "Could not log push" };
    }
    pushId = inserted.id;
  }

  try {
    let recordId = caseRow.practicebetter_record_id;
    let createdNewRecord = false;

    if (!recordId) {
      // Cache-first lookup. The synced practicebetter_clients table is the
      // source of truth — populated by syncPracticeBetterClients(). Falls back
      // to live PB pagination only if the cache is genuinely empty (first run).
      const target = caseRow.patient_email.trim().toLowerCase();
      const { data: cacheHit } = await db
        .from("practicebetter_clients")
        .select("record_id")
        .eq("email_lowered", target)
        .maybeSingle();

      if (cacheHit?.record_id) {
        recordId = cacheHit.record_id;
      } else {
        const { count } = await db
          .from("practicebetter_clients")
          .select("record_id", { count: "exact", head: true });
        const cacheIsEmpty = !count || count === 0;

        const lookup = cacheIsEmpty
          ? await findRecordByEmailWithDiagnostics(caseRow.patient_email)
          : {
              match: null as null,
              scanned: count ?? 0,
              pagesScanned: 0,
              hadMoreAfterScan: false,
              sampleEmailsSeen: [] as string[],
            };

        if (lookup.match) {
          recordId = lookup.match.id;
        } else {
          // Not found in cache (or in live PB list, if the cache was empty)
          // → auto-create from patient_name + patient_email. Covers
          // brand-new patients who haven't been added to PB yet.
          const { firstName, lastName } = splitName(caseRow.patient_name);
          try {
            const created = await createRecord({
              firstName,
              lastName,
              email: caseRow.patient_email,
            });
            recordId = created.id;
            createdNewRecord = true;
          } catch (createErr) {
            const message =
              createErr instanceof PracticeBetterError
                ? `PB ${createErr.status}: ${createErr.body || createErr.message}`
                : createErr instanceof Error
                  ? createErr.message
                  : "Unknown create error";
            throw new Error(
              `Auto-create failed for ${caseRow.patient_email}: ${message}. ` +
                (cacheIsEmpty
                  ? `Cache was empty; live lookup scanned ${lookup.scanned} records across ${lookup.pagesScanned} pages` +
                    (lookup.hadMoreAfterScan
                      ? " and stopped early (more pages exist)"
                      : "") +
                    `. Sample emails seen: ${lookup.sampleEmailsSeen.join(", ") || "(none)"}.`
                  : `Cache has ${lookup.scanned} records but no email match — run "Sync PB clients" if it's stale, then retry.`),
            );
          }
        }
      }

      await db
        .from("lab_cases")
        .update({ practicebetter_record_id: recordId })
        .eq("id", caseId);
    }

    if (!recordId) {
      throw new Error("Internal: recordId not resolved after lookup/create.");
    }
    const resolvedRecordId: string = recordId;

    const pushedAt = new Date().toISOString();
    const block = buildNoteBlock({ caseRow, kind, marker, pushedAt });
    const writeResult = await appendNotesToRecord({
      recordId: resolvedRecordId,
      blockToAppend: block,
      marker,
    });
    const { updated } = writeResult;

    await db
      .from("practicebetter_pushes")
      .update({
        status: updated ? "sent" : "skipped",
        record_id: resolvedRecordId,
        notes_appended: updated,
        succeeded_at: pushedAt,
        error_message: null,
      })
      .eq("id", pushId);

    revalidatePath("/labs");
    revalidatePath(`/labs/${caseId}`);
    return {
      ok: true,
      data: {
        recordId: resolvedRecordId,
        notesAppended: updated,
        skippedReason: updated
          ? undefined
          : createdNewRecord
            ? undefined
            : "marker already present in PB notes",
        createdNewRecord,
        writeMethod: writeResult.methodUsed ?? null,
        writeStatus: writeResult.responseStatus ?? null,
      },
    };
  } catch (err) {
    const message =
      err instanceof PracticeBetterError
        ? `PB ${err.status}: ${err.body || err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown error";
    await db
      .from("practicebetter_pushes")
      .update({ status: "failed", error_message: message })
      .eq("id", pushId);
    return { ok: false, error: message };
  }
}

export async function checkPracticeBetterHealth() {
  await requireAdmin();
  return pbHealthCheck();
}

export async function syncPracticeBetterClientsAction() {
  await requireAdmin();
  const r = await syncPracticeBetterClients();
  revalidatePath("/labs/inbox");
  return r;
}

export async function getPracticeBetterSyncStatus() {
  await requireAdmin();
  return getLatestPracticeBetterSync();
}

export async function dumpPracticeBetterFirstPage() {
  await requireAdmin();
  return pbDumpFirstPage();
}

/** Diagnostic: try POST /consultant/labrequests and POST /consultant/sessionnotes
 *  against the case's linked record, returning status codes + bodies. */
export async function probePracticeBetterWriteEndpoints(input: {
  caseId: string;
}): Promise<
  ActionResult<{
    labRequest: { method: string; status: number; body: string };
    sessionNote: { method: string; status: number; body: string };
  }>
> {
  await requireAdmin();
  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("practicebetter_record_id, lab_name")
    .eq("id", input.caseId)
    .maybeSingle();
  const row = caseRow as
    | { practicebetter_record_id: string | null; lab_name: string }
    | null;
  if (!row?.practicebetter_record_id) {
    return { ok: false, error: "Case is not linked to a PB record." };
  }
  try {
    const result = await probeWriteEndpoints({
      recordId: row.practicebetter_record_id,
      caseId: input.caseId,
      labName: row.lab_name,
    });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown",
    };
  }
}

/** Returns the raw profile.notes for a case's linked PB record — used to
 *  confirm where in PB's UI those notes are surfaced. */
export async function dumpPracticeBetterNotesForCase(input: {
  caseId: string;
}): Promise<
  ActionResult<{
    recordId: string | null;
    notes: string | null;
    profileKeys: string[];
  }>
> {
  await requireAdmin();
  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("practicebetter_record_id")
    .eq("id", input.caseId)
    .maybeSingle();
  const recordId = (caseRow as { practicebetter_record_id: string | null } | null)
    ?.practicebetter_record_id;
  if (!recordId) {
    return { ok: false, error: "Case is not linked to a PB record." };
  }
  try {
    const record = await getRecordById(recordId);
    if (!record) return { ok: false, error: "PB record not found." };
    return {
      ok: true,
      data: {
        recordId,
        notes: record.profile?.notes ?? null,
        profileKeys: Object.keys(record.profile ?? {}),
      },
    };
  } catch (err) {
    const message =
      err instanceof PracticeBetterError
        ? `PB ${err.status}: ${err.body || err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown";
    return { ok: false, error: message };
  }
}

const LinkInput = z.object({
  caseId: z.string().uuid(),
  recordId: z.string().trim().min(1).max(500),
});

/** Accepts a bare PB record id, or a PB URL like
 *  https://my.practicebetter.io/#/p/clients/641868664a3099220158325b
 *  Returns just the id (24-char hex objectId, by inspection). */
function extractPracticeBetterRecordId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // First, look for a 24-hex-char Mongo-style ObjectID anywhere in the string.
  // PB record ids appear to use this format (e.g. 641868664a3099220158325b).
  const hex = trimmed.match(/[a-f0-9]{24}/i);
  if (hex) return hex[0];

  // Fallback: take the last non-empty path segment.
  const parts = trimmed.split(/[\/?#]/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 8 && last.length <= 64 ? last : null;
}

/**
 * Manually link a case to a PB record_id. Verifies the id by fetching the
 * record from PB; if found, stores it on the case so the push action can use
 * it directly. Bypasses the broken list endpoint.
 */
export async function linkCaseToPracticeBetterRecord(input: {
  caseId: string;
  recordId: string;
}): Promise<
  ActionResult<{
    recordId: string;
    email: string | null;
    name: string | null;
  }>
> {
  await requireAdmin();
  const parsed = LinkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const extracted = extractPracticeBetterRecordId(parsed.data.recordId);
  if (!extracted) {
    return {
      ok: false,
      error:
        "Couldn't extract a PB record ID. Paste the ID from PB's client URL (the 24-char hex string after /clients/).",
    };
  }

  try {
    const record = await getRecordById(extracted);
    if (!record) {
      return { ok: false, error: `PB record not found for ID ${extracted}.` };
    }
    const db = getSupabaseAdmin();
    const { error } = await db
      .from("lab_cases")
      .update({ practicebetter_record_id: record.id })
      .eq("id", parsed.data.caseId);
    if (error) return { ok: false, error: error.message };

    revalidatePath("/labs");
    revalidatePath(`/labs/${parsed.data.caseId}`);

    const email =
      record.profile?.emailAddress ?? record.client?.emailAddress ?? null;
    const name = [record.profile?.firstName, record.profile?.lastName]
      .filter(Boolean)
      .join(" ");
    return {
      ok: true,
      data: { recordId: record.id, email, name: name || null },
    };
  } catch (err) {
    const message =
      err instanceof PracticeBetterError
        ? `PB ${err.status}: ${err.body || err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown";
    return { ok: false, error: message };
  }
}
