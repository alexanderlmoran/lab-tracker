// Diagnose why a gmail_poll inbound email ended up with zero
// inbound_attachments rows: re-runs the sync's attachment path
// (collectPdfParts → attachments.get → pdf-parse) against the REAL Gmail
// message with every error printed instead of swallowed. Read-only.
//
//   npx tsx --env-file=.env.local scripts/diagnose-inbound-attachment.ts <gmailMessageId>
import { google, type gmail_v1 } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
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
  if (part.parts) for (const child of part.parts) collectPdfParts(child, acc);
  return acc;
}

function describeParts(part: gmail_v1.Schema$MessagePart | undefined, depth = 0): void {
  if (!part) return;
  console.log(
    `${"  ".repeat(depth)}- mime=${part.mimeType} filename=${JSON.stringify(part.filename ?? "")} ` +
      `attachmentId=${part.body?.attachmentId ? "yes" : "no"} size=${part.body?.size ?? 0}`,
  );
  for (const child of part.parts ?? []) describeParts(child, depth + 1);
}

async function main() {
  const messageId = process.argv[2];
  if (!messageId) throw new Error("usage: ... <gmailMessageId>");

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  );
  const { data: tok, error } = await db
    .from("gmail_oauth_tokens")
    .select("access_token, refresh_token, expires_at, scopes")
    .limit(1)
    .single();
  if (error || !tok) throw new Error(`no gmail token row: ${error?.message}`);
  console.log(`token scopes: ${tok.scopes} expires_at: ${tok.expires_at}`);

  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth.setCredentials({ access_token: tok.access_token, refresh_token: tok.refresh_token });
  const gmail = google.gmail({ version: "v1", auth: oauth });

  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const payload = full.data.payload;
  if (!payload) throw new Error("no payload");
  console.log("\nMIME tree:");
  describeParts(payload);

  const parts = collectPdfParts(payload);
  console.log(`\ncollectPdfParts found ${parts.length} pdf part(s):`, parts);

  for (const p of parts) {
    try {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: p.attachmentId,
      });
      const dataLen = att.data.data?.length ?? 0;
      console.log(`\nattachments.get ok for ${p.filename}: base64url len=${dataLen}`);
      if (!att.data.data) continue;
      const buf = decodeBase64Url(att.data.data);
      console.log(`decoded ${buf.byteLength} bytes, header=${buf.subarray(0, 8).toString("latin1")}`);
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      const parser = new PDFParse({ data: new Uint8Array(ab) });
      try {
        const result = await parser.getText();
        console.log(`extracted text (${(result.text ?? "").length} chars):`);
        console.log((result.text ?? "").slice(0, 600));
      } finally {
        await parser.destroy();
      }
    } catch (e) {
      console.error(`FAILED on part ${p.filename}:`, e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
