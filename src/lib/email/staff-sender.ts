// Shared sender for the staff-facing emails (invites + password resets).
// Reads the DB-overridable template, applies placeholders, renders through
// the same React-email layout patient emails use, and ships via Resend.
//
// Why this lives in its own module: it's used from /labs/settings (invite +
// regenerate magic link) AND from /login (forgot password) — both server
// actions need the same dispatch primitive but with different `kind`s.

import { render } from "@react-email/components";
import * as React from "react";
import { Resend } from "resend";
import { PatientEmail } from "./templates";
import { loadEmailConfig } from "./render";
import {
  applyPlaceholders,
  firstNameOf,
  loadStaffTemplate,
  type StaffEmailKind,
} from "./template-data";

export type SendStaffResult = { ok: true } | { ok: false; error: string };

export async function sendStaffEmail(args: {
  kind: StaffEmailKind;
  toEmail: string;
  fullName: string | null;
  magicLink: string;
}): Promise<SendStaffResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };

  const [ctx, template] = await Promise.all([
    loadEmailConfig(),
    loadStaffTemplate(args.kind),
  ]);

  const placeholders: Record<string, string> = {
    inviteeName: args.fullName ?? "there",
    inviteeFirstName: args.fullName ? firstNameOf(args.fullName) : "there",
    inviteeEmail: args.toEmail,
    practiceName: ctx.practiceName,
    magicLink: args.magicLink,
  };

  const subject = applyPlaceholders(template.subject, placeholders);
  const heading = template.heading
    ? applyPlaceholders(template.heading, placeholders)
    : null;
  const paragraphs = template.paragraphs.map((p) =>
    applyPlaceholders(p, placeholders),
  );

  const element = React.createElement(PatientEmail, {
    preview: subject,
    heading,
    paragraphs,
    practiceName: ctx.practiceName,
    practiceAddress: ctx.practiceAddress,
  });
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });

  const finalSubject = ctx.testRedirect
    ? `[TEST → ${args.toEmail}] ${subject}`
    : subject;

  try {
    const result = await new Resend(key).emails.send({
      from: ctx.fromHeader,
      to: [ctx.testRedirect ?? args.toEmail],
      replyTo: ctx.replyTo,
      subject: finalSubject,
      html,
      text,
      bcc:
        ctx.testRedirect || template.bcc.length === 0
          ? undefined
          : template.bcc,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}
