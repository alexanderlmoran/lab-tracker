import "server-only";
import { google, type gmail_v1 } from "googleapis";
import { getAuthorizedGmailClient } from "./client";
import { extractPdfText } from "@/lib/inbound/extract-pdf";
import { parseLabReportWithClaude } from "@/lib/inbound/parse-with-claude";
import { matchCase } from "@/lib/inbound/match-case";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { LabCase } from "@/lib/types";

export type SyncResult = {
  processed: number;
  skipped: number;
  errors: number;
  details: Array<{ messageId: string; status: "parsed" | "skipped" | "error"; note?: string }>;
};

const SYNC_QUERY =
  "has:attachment filename:pdf newer_than:30d -in:trash -in:drafts";

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

function findHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  return headers.find((h) => (h.name ?? "").toLowerCase() === lower)?.value ?? null;
}

function collectPdfParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: Array<{ filename: string; attachmentId: string; mimeType: string }> = [],
): Array<{ filename: string; attachmentId: string; mimeType: string }> {
  if (!part) return acc;
  const isPdf =
    (part.mimeType ?? "").toLowerCase() === "application/pdf" ||
    (part.filename ?? "").toLowerCase().endsWith(".pdf");
  if (isPdf && part.body?.attachmentId && part.filename) {
    acc.push({
      filename: part.filename,
      attachmentId: part.body.attachmentId,
      mimeType: part.mimeType ?? "application/pdf",
    });
  }
  if (part.parts) {
    for (const child of part.parts) collectPdfParts(child, acc);
  }
  return acc;
}

function extractBodyText(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).toString("utf8");
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const text = extractBodyText(p);
      if (text) return text;
    }
  }
  return "";
}

export async function syncGmailInbox(): Promise<SyncResult> {
  const auth = await getAuthorizedGmailClient();
  if (!auth) {
    throw new Error("Gmail not connected. Click Connect Gmail first.");
  }
  const gmail = google.gmail({ version: "v1", auth: auth.auth });
  const db = getSupabaseAdmin();

  const result: SyncResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  const list = await gmail.users.messages.list({
    userId: "me",
    q: SYNC_QUERY,
    maxResults: 50,
  });
  const messages = list.data.messages ?? [];

  // Pre-load existing message IDs to skip duplicates fast.
  if (messages.length > 0) {
    const ids = messages.map((m) => m.id ?? "").filter(Boolean);
    const { data: existing } = await db
      .from("inbound_emails")
      .select("external_id")
      .eq("source", "gmail_poll")
      .in("external_id", ids);
    const seen = new Set(
      ((existing ?? []) as { external_id: string }[]).map((r) => r.external_id),
    );

    // Pre-load all cases for matching.
    const { data: caseRows } = await db.from("lab_cases").select("*");
    const cases = (caseRows ?? []) as LabCase[];

    for (const m of messages) {
      const id = m.id;
      if (!id) continue;
      if (seen.has(id)) {
        result.skipped += 1;
        result.details.push({ messageId: id, status: "skipped", note: "already ingested" });
        continue;
      }

      try {
        const full = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        const payload = full.data.payload;
        if (!payload) {
          result.errors += 1;
          result.details.push({ messageId: id, status: "error", note: "no payload" });
          continue;
        }
        const subject = findHeader(payload.headers, "Subject");
        const fromAddr = findHeader(payload.headers, "From");
        const dateStr = findHeader(payload.headers, "Date");
        const bodyText = extractBodyText(payload);
        const pdfParts = collectPdfParts(payload);

        const attachmentTexts: Array<{ filename: string; text: string }> = [];
        for (const part of pdfParts) {
          try {
            const att = await gmail.users.messages.attachments.get({
              userId: "me",
              messageId: id,
              id: part.attachmentId,
            });
            if (!att.data.data) continue;
            const buf = decodeBase64Url(att.data.data);
            // Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer types.
            const ab = new ArrayBuffer(buf.byteLength);
            new Uint8Array(ab).set(buf);
            const text = await extractPdfText(ab);
            attachmentTexts.push({ filename: part.filename, text });
          } catch {
            // Attachment fetch / parse failed — skip just this part.
          }
        }

        const { data: emailRow, error: insertErr } = await db
          .from("inbound_emails")
          .insert({
            source: "gmail_poll",
            external_id: id,
            from_address: fromAddr,
            subject: subject,
            received_at: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
            body_text: bodyText.slice(0, 20_000),
            parser_status: "pending",
          })
          .select("id")
          .single();
        if (insertErr || !emailRow) {
          result.errors += 1;
          result.details.push({ messageId: id, status: "error", note: insertErr?.message });
          continue;
        }
        const inboundId = (emailRow as { id: string }).id;

        if (attachmentTexts.length > 0) {
          await db.from("inbound_attachments").insert(
            attachmentTexts.map((a) => ({
              inbound_email_id: inboundId,
              filename: a.filename,
              content_type: "application/pdf",
              size_bytes: null,
              storage_path: null,
              extracted_text: a.text,
            })),
          );
        }

        try {
          const extracted = await parseLabReportWithClaude({
            subject,
            fromAddress: fromAddr,
            bodyText,
            attachmentTexts,
          });
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
          result.processed += 1;
          result.details.push({ messageId: id, status: "parsed" });
        } catch (parseErr) {
          await db
            .from("inbound_emails")
            .update({
              parser_status: "failed",
              parser_error:
                parseErr instanceof Error ? parseErr.message : "Parse failed",
            })
            .eq("id", inboundId);
          result.errors += 1;
          result.details.push({
            messageId: id,
            status: "error",
            note: parseErr instanceof Error ? parseErr.message : undefined,
          });
        }
      } catch (err) {
        result.errors += 1;
        result.details.push({
          messageId: id,
          status: "error",
          note: err instanceof Error ? err.message : undefined,
        });
      }
    }
  }

  await db
    .from("gmail_oauth_tokens")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", "primary");

  return result;
}
