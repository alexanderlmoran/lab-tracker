import "server-only";
import { google } from "googleapis";
import { Resend } from "resend";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { getAuthorizedGmailClient } from "@/lib/gmail/client";
import { collectPdfParts, decodeBase64Url } from "@/lib/gmail/sync";
import { loadEmailConfig } from "@/lib/email/render";

// Kennedy Krieger (Phase A): KK results arrive by email only (encrypted PDFs
// the parser can't read) and the standing instruction is "forward the PDF to
// BodyBio". Defaults to a TEST address until verified — set
// KK_FORWARD_TO=results@bodybio.com to go live.

export type KkForwardResult =
  | { ok: true; to: string; filename: string }
  | { ok: false; error: string };

/**
 * Fetch the email's PDF from Gmail, send it to BodyBio via Resend, and MARK
 * the inbound row (applied / forwarded_bodybio) so the inbox shows a
 * "forwarded" badge instead of leaving the row looking untouched.
 */
export async function forwardKkPdf(
  inboundEmailId: string,
  actor: string,
): Promise<KkForwardResult> {
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

  // Mark the row — previously the forward left no trace on the inbox, so a
  // forwarded email still looked actionable.
  await db
    .from("inbound_emails")
    .update({
      parser_status: "applied",
      applied_action: "forwarded_bodybio",
      reviewed_by: actor,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", inboundEmailId);

  return { ok: true, to, filename };
}
