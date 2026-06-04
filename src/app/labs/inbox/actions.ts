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

// Kennedy Krieger (Phase A): forward the raw KK PDF to BodyBio. Defaults to a
// TEST address until verified — set KK_FORWARD_TO=results@bodybio.com to go
// live. The sync only stored extracted text, so re-fetch the PDF bytes from
// Gmail by message id, then send via Resend with the PDF attached.
export async function forwardKkEmailToBodyBio(
  inboundEmailId: string,
): Promise<ActionResult<{ to: string; filename: string }>> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: email } = await db
    .from("inbound_emails")
    .select("external_id, from_address, subject")
    .eq("id", inboundEmailId)
    .maybeSingle();
  const row = email as
    | { external_id: string | null; from_address: string | null; subject: string | null }
    | null;
  if (!row?.external_id) return { ok: false, error: "Email not found or missing Gmail id." };

  const auth = await getAuthorizedGmailClient();
  if (!auth) return { ok: false, error: "Gmail isn't connected — connect it in the Inbox panel first." };
  const gmail = google.gmail({ version: "v1", auth: auth.auth });

  let buf: Buffer;
  let filename: string;
  try {
    const msg = await gmail.users.messages.get({ userId: "me", id: row.external_id, format: "full" });
    const parts = collectPdfParts(msg.data.payload ?? {});
    if (parts.length === 0) return { ok: false, error: "No PDF attachment on that email." };
    const part = parts[0];
    filename = part.filename || "kennedy-krieger.pdf";
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: row.external_id,
      id: part.attachmentId,
    });
    if (!att.data.data) return { ok: false, error: "Could not fetch the PDF bytes from Gmail." };
    buf = decodeBase64Url(att.data.data);
  } catch (err) {
    return { ok: false, error: `Gmail fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const to = process.env.KK_FORWARD_TO?.trim() || "alex@centnerhb.com";
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set." };

  try {
    const ctx = await loadEmailConfig();
    const result = await new Resend(key).emails.send({
      from: ctx.fromHeader,
      to: [to],
      replyTo: ctx.replyTo,
      subject: `FW: ${row.subject ?? "Kennedy Krieger result"}`,
      text: `Forwarded Kennedy Krieger lab PDF (originally from ${row.from_address ?? "?"}). Original subject: ${row.subject ?? "(none)"}.`,
      attachments: [{ filename, content: buf.toString("base64") }],
    });
    if (result.error) return { ok: false, error: result.error.message };
  } catch (err) {
    return { ok: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  revalidatePath("/labs/inbox");
  return { ok: true, data: { to, filename } };
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
    .limit(200);
  if (error) throw new Error(error.message);
  const list = (emails ?? []) as InboundEmail[];

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
