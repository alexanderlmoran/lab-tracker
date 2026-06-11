"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { google } from "googleapis";
import { Resend } from "resend";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { extractPdfText } from "@/lib/inbound/extract-pdf";
import { parseLabReportWithClaude } from "@/lib/inbound/parse-with-claude";
import { matchCase } from "@/lib/inbound/match-case";
import { getAuthorizedGmailClient } from "@/lib/gmail/client";
import { collectPdfParts, decodeBase64Url } from "@/lib/gmail/sync";
import { loadEmailConfig } from "@/lib/email/render";
import type {
  ActionResult,
  InboundAttachment,
  InboundEmail,
  InboundEmailExtracted,
  LabCase,
} from "@/lib/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Kennedy Krieger (Phase A): forward the raw KK PDF to BodyBio. The sync now
// auto-forwards on arrival; this button is the manual retry. Core (fetch +
// send + mark the row) lives in @/lib/inbound/forward-kk.
export async function forwardKkEmailToBodyBio(
  inboundEmailId: string,
): Promise<ActionResult<{ to: string; filename: string }>> {
  const user = await requireSignedIn();
  const { forwardKkPdf } = await import("@/lib/inbound/forward-kk");
  const r = await forwardKkPdf(inboundEmailId, user.email ?? "staff");
  revalidatePath("/labs/inbox");
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { to: r.to, filename: r.filename } };
}

export async function uploadInboundEmail(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  await requireSignedIn();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file provided" };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File too large (10 MB max)" };
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return { ok: false, error: "Only PDF files are supported in v1." };
  }

  const buf = await file.arrayBuffer();
  let text = "";
  try {
    text = await extractPdfText(buf);
  } catch (err) {
    return {
      ok: false,
      error: `PDF extraction failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  const db = getSupabaseAdmin();
  const subject = (formData.get("subject") as string | null) ?? file.name;
  const fromAddress = (formData.get("from") as string | null) ?? null;

  const { data: emailRow, error: insertErr } = await db
    .from("inbound_emails")
    .insert({
      source: "manual_upload",
      external_id: null,
      from_address: fromAddress,
      subject,
      body_text: null,
      parser_status: "pending",
    })
    .select("id")
    .single();
  if (insertErr || !emailRow) {
    return { ok: false, error: insertErr?.message ?? "Insert failed" };
  }
  const inboundId = (emailRow as { id: string }).id;

  await db.from("inbound_attachments").insert({
    inbound_email_id: inboundId,
    filename: file.name,
    content_type: file.type || "application/pdf",
    size_bytes: file.size,
    storage_path: null,
    extracted_text: text,
  });

  // Parse with Claude.
  let extracted: InboundEmailExtracted;
  try {
    extracted = await parseLabReportWithClaude({
      subject,
      fromAddress,
      bodyText: null,
      attachmentTexts: [{ filename: file.name, text }],
    });
  } catch (err) {
    await db
      .from("inbound_emails")
      .update({
        parser_status: "failed",
        parser_error: err instanceof Error ? err.message : "Parse failed",
      })
      .eq("id", inboundId);
    revalidatePath("/labs/inbox");
    return { ok: true, data: { id: inboundId } };
  }

  // Match against active cases.
  const { data: caseRows } = await db.from("lab_cases").select("*");
  const cases = (caseRows ?? []) as LabCase[];
  const match = matchCase(extracted, cases);

  await db
    .from("inbound_emails")
    .update({
      parser_status: "parsed",
      parser_extracted: extracted,
      matched_case_id: match.caseId,
      matched_confidence: match.confidence,
    })
    .eq("id", inboundId);

  revalidatePath("/labs/inbox");
  return { ok: true, data: { id: inboundId } };
}

export async function listInboundEmails(): Promise<
  Array<InboundEmail & { attachments: InboundAttachment[] }>
> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data: emails, error } = await db
    .from("inbound_emails")
    .select("*")
    // Chronological by when the email actually arrived (received_at), newest
    // first — not ingest time, which batches out of order.
    .order("received_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);

  // Hide inbox noise — billing receipts, supply-order pings, and dismissed
  // rows aren't actionable lab results. Kept in the DB; just not shown here.
  const isNoise = (e: InboundEmail): boolean => {
    if (e.parser_status === "dismissed") return true;
    const from = (e.from_address ?? "").toLowerCase();
    const subj = (e.subject ?? "").toLowerCase();
    if (from.includes("billingdept@vibrant-america.com")) return true;
    if (/vibrant receipt|collection supplies|supplies ordered/.test(subj)) return true;
    return false;
  };
  const list = ((emails ?? []) as InboundEmail[]).filter((e) => !isNoise(e));

  if (list.length === 0) return [];
  const ids = list.map((e) => e.id);
  const { data: atts } = await db
    .from("inbound_attachments")
    .select("*")
    .in("inbound_email_id", ids);
  const byEmail = new Map<string, InboundAttachment[]>();
  for (const a of (atts ?? []) as InboundAttachment[]) {
    const arr = byEmail.get(a.inbound_email_id) ?? [];
    arr.push(a);
    byEmail.set(a.inbound_email_id, arr);
  }
  return list.map((e) => ({
    ...e,
    attachments: byEmail.get(e.id) ?? [],
  }));
}

const ApplyInput = z.object({
  inboundId: z.string().uuid(),
  caseId: z.string().uuid(),
  /** Which step boolean to flip true (4 = complete received, 2 = partial). */
  step: z.union([z.literal(2), z.literal(4)]),
});

export async function applyInboundEmail(input: {
  inboundId: string;
  caseId: string;
  step: 2 | 4;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = ApplyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { inboundId, caseId, step } = parsed.data;
  const db = getSupabaseAdmin();

  const dbCol = step === 2 ? "step2_partial_received" : "step4_complete_received";
  const { error: updErr } = await db
    .from("lab_cases")
    .update({ [dbCol]: true })
    .eq("id", caseId);
  if (updErr) return { ok: false, error: updErr.message };

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "step_toggled",
    step,
    completed: true,
    actor: user.email ?? "admin",
    meta: { source: "inbound_email", inbound_id: inboundId },
  });

  await db
    .from("inbound_emails")
    .update({
      parser_status: "applied",
      applied_action: dbCol,
      matched_case_id: caseId,
      reviewed_by: user.email ?? "admin",
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", inboundId);

  revalidatePath("/labs");
  revalidatePath("/labs/inbox");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

/** Re-run extraction + Claude parse + case match for one ingested row — the
 * recovery button for rows that failed transiently (bad API key, the
 * pdf-parse import bug) without waiting to re-receive the email. */
export async function reparseInboundEmail(input: {
  inboundId: string;
}): Promise<ActionResult<{ status: string }>> {
  await requireSignedIn();
  const { reprocessInboundEmail } = await import("@/lib/gmail/sync");
  const r = await reprocessInboundEmail(input.inboundId);
  revalidatePath("/labs/inbox");
  if (!r.ok) return { ok: false, error: r.error ?? "Re-parse failed" };
  return { ok: true, data: { status: r.status ?? "parsed" } };
}

const PostToPbInput = z.object({
  inboundId: z.string().uuid(),
  /** Post onto an existing case… */
  caseId: z.string().uuid().nullable().optional(),
  /** …or create one first (outside labs — patient-forwarded Quest etc.). */
  createCase: z
    .object({
      patientName: z.string().min(1),
      labName: z.string().min(1),
      patientEmail: z.string().nullable().optional(),
      patientDob: z.string().nullable().optional(),
      collectionDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    })
    .optional(),
});

/**
 * Post the email's PDF as a case's RESULT: re-fetch the attachment bytes from
 * Gmail (the sync stores only extracted text), then stage them through the
 * manual-upload path — which auto-approves and queues to PracticeBetter; the
 * card lands in Complete Uploaded when the PB worker confirms. `createCase`
 * makes the case first (with the report's collection date, so PB's Date
 * Ordered is right), inheriting email/DOB from the patient's existing cases
 * so the new card groups under the same patient.
 */
export async function postInboundToPb(input: {
  inboundId: string;
  caseId?: string | null;
  createCase?: {
    patientName: string;
    labName: string;
    patientEmail?: string | null;
    patientDob?: string | null;
    collectionDate?: string | null;
  };
}): Promise<ActionResult<{ caseId: string }>> {
  const user = await requireSignedIn();
  const parsed = PostToPbInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { inboundId, createCase } = parsed.data;
  let caseId = parsed.data.caseId ?? null;
  if (!caseId && !createCase) {
    return { ok: false, error: "Pick a case, or provide new-case details." };
  }
  const db = getSupabaseAdmin();

  const { data: row } = await db
    .from("inbound_emails")
    .select("id, external_id, source, subject")
    .eq("id", inboundId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Email not found" };
  const externalId = (row as { external_id: string | null }).external_id;
  if ((row as { source: string }).source !== "gmail_poll" || !externalId) {
    return { ok: false, error: "Only Gmail-ingested emails can be posted (no stored PDF bytes)." };
  }

  const auth = await getAuthorizedGmailClient();
  if (!auth) return { ok: false, error: "Gmail not connected." };
  const gmail = google.gmail({ version: "v1", auth: auth.auth });
  const full = await gmail.users.messages.get({ userId: "me", id: externalId, format: "full" });
  const parts = collectPdfParts(full.data.payload ?? undefined);
  if (parts.length === 0) return { ok: false, error: "No PDF attachment on this email." };
  // First PDF; Allison's forwards carry exactly one. Multi-PDF emails can be
  // posted per attachment later if that ever becomes a real shape.
  const part = parts[0];
  const att = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: externalId,
    id: part.attachmentId,
  });
  if (!att.data.data) return { ok: false, error: "Couldn't download the attachment." };
  const pdfBase64 = decodeBase64Url(att.data.data).toString("base64");

  if (!caseId && createCase) {
    // Reports print names as "ALVAREZ, LIDIA"; the tracker stores
    // "Lidia Alvarez". Normalize comma-form to First Last so the new card
    // reads like its siblings and the kin lookup below can match.
    const rawName = createCase.patientName.trim();
    const patientName = rawName.includes(",")
      ? rawName
          .split(",")
          .map((p) => p.trim())
          .reverse()
          .join(" ")
      : rawName;
    // Inherit identity from the patient's existing cases when the name
    // matches — the boards group patients by email, so an empty email would
    // orphan the new card. (Lidia's first Quest post landed with "" email
    // because the comma-form name matched nothing.)
    const { data: kin } = await db
      .from("lab_cases")
      .select("patient_email, patient_dob")
      .ilike("patient_name", patientName)
      .neq("patient_email", "")
      .limit(1)
      .maybeSingle();
    const { data: created, error: createErr } = await db
      .from("lab_cases")
      .insert({
        patient_name: patientName,
        patient_email:
          createCase.patientEmail ||
          ((kin as { patient_email: string } | null)?.patient_email ?? ""),
        patient_dob:
          createCase.patientDob ?? (kin as { patient_dob: string | null } | null)?.patient_dob ?? null,
        lab_name: createCase.labName,
        collection_date: createCase.collectionDate ?? null,
      })
      .select("id")
      .single();
    if (createErr || !created) {
      return { ok: false, error: createErr?.message ?? "Couldn't create the case" };
    }
    caseId = (created as { id: string }).id;
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "case_created",
      actor: user.email ?? "staff",
      note: `Created from inbox email "${(row as { subject: string | null }).subject ?? ""}"`,
      meta: { inbound_id: inboundId },
    });
  }

  const { uploadResultPdf } = await import("../probe-actions");
  const up = await uploadResultPdf({
    caseId: caseId!,
    pdfBase64,
    filename: part.filename || "inbound.pdf",
  });
  if (!up.ok) return { ok: false, error: up.error };

  await db
    .from("inbound_emails")
    .update({
      parser_status: "applied",
      applied_action: "posted_to_pb",
      matched_case_id: caseId,
      reviewed_by: user.email ?? "admin",
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", inboundId);

  revalidatePath("/labs");
  revalidatePath("/labs/inbox");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true, data: { caseId: caseId! } };
}

export async function dismissInboundEmail(input: {
  inboundId: string;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("inbound_emails")
    .update({
      parser_status: "dismissed",
      reviewed_by: user.email ?? "admin",
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", input.inboundId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/inbox");
  return { ok: true };
}

export async function syncGmailNow(): Promise<
  ActionResult<{ processed: number; skipped: number; errors: number }>
> {
  await requireSignedIn();
  try {
    const { syncGmailInbox } = await import("@/lib/gmail/sync");
    const result = await syncGmailInbox();
    revalidatePath("/labs/inbox");
    return {
      ok: true,
      data: {
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Sync failed",
    };
  }
}

export async function disconnectGmail(): Promise<ActionResult> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("gmail_oauth_tokens")
    .delete()
    .eq("id", "primary");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/inbox");
  return { ok: true };
}

export async function getGmailConnectionState(): Promise<{
  connected: boolean;
  email?: string;
  lastSyncedAt?: string | null;
}> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("gmail_oauth_tokens")
    .select("email, last_synced_at")
    .eq("id", "primary")
    .maybeSingle();
  if (!data) return { connected: false };
  const row = data as { email: string; last_synced_at: string | null };
  return {
    connected: true,
    email: row.email,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function rematchInboundEmail(input: {
  inboundId: string;
  caseId: string;
}): Promise<ActionResult> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("inbound_emails")
    .update({
      matched_case_id: input.caseId,
      matched_confidence: "high",
    })
    .eq("id", input.inboundId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/inbox");
  return { ok: true };
}
