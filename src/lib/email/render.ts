import { render } from "@react-email/components";
import * as React from "react";
import type { LabCase, EmailKind } from "@/lib/types";
import { findLabByName } from "@/lib/labs/catalog";
import {
  CompleteUploaded,
  PartialUploaded,
  RofFollowup,
  SampleSent,
} from "./templates";

export type RenderedEmail = {
  to: string[];
  bcc?: string[];
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  isTestRedirect: boolean;
  originalTo: string;
};

export const SUBJECT: Record<EmailKind, string> = {
  sample_sent: "Sample Received",
  partial_uploaded: "Partial Results Received",
  complete_uploaded: "Complete Results Received",
  rof_followup: "Thanks for your review — here's what's next",
};

// Operational BCC per email kind. These are practice routing rules, not
// per-environment config — hardcoded so they ship with the template change.
export const BCC_BY_KIND: Record<EmailKind, string[]> = {
  sample_sent: [
    "chrisc@centnerwellness.com",
    "info@centnerwellness.com",
  ],
  partial_uploaded: ["chrisc@centnerwellness.com"],
  complete_uploaded: [
    "chrisc@centnerwellness.com",
    "nadia@centnerwellness.com",
  ],
  rof_followup: [],
};

export function envEmailConfig() {
  const fromEmail = process.env.ALERT_FROM_EMAIL ?? "";
  const replyTo = process.env.REPLY_TO_EMAIL || undefined;
  const practiceName = stripQuotes(process.env.PRACTICE_NAME ?? "");
  const practiceAddress = stripQuotes(process.env.PRACTICE_MAILING_ADDRESS ?? "") || null;
  const testRedirect = (process.env.EMAIL_TEST_REDIRECT ?? "").trim() || null;
  const fromHeader = practiceName
    ? `${practiceName} <${fromEmail}>`
    : fromEmail;
  return {
    fromEmail,
    fromHeader,
    replyTo,
    practiceName,
    practiceAddress,
    testRedirect,
  };
}

function stripQuotes(s: string) {
  return s.replace(/^['"](.+)['"]$/, "$1");
}

function turnaroundTextFor(row: LabCase): string {
  const lookupKey = row.lab_panel
    ? `${row.lab_name} ${row.lab_panel}`
    : row.lab_name;
  const entry =
    findLabByName(lookupKey) ?? findLabByName(row.lab_name) ?? null;
  const min = entry?.turnaroundDaysMin ?? null;
  const max = entry?.turnaroundDaysMax ?? null;
  if (min == null && max == null) return "a few weeks";
  if (min != null && max != null && min !== max) {
    if (max > 14) {
      const wMin = Math.max(1, Math.round(min / 7));
      const wMax = Math.max(1, Math.round(max / 7));
      if (wMin === wMax) return `${wMax} weeks`;
      return `${wMin} to ${wMax} weeks`;
    }
    return `${min} to ${max} business days`;
  }
  const single = (max ?? min) as number;
  if (single > 14) {
    const w = Math.max(1, Math.round(single / 7));
    return `${w} weeks`;
  }
  return `${single} business days`;
}

function templateFor(kind: EmailKind, row: LabCase, ctx: ReturnType<typeof envEmailConfig>) {
  const common = {
    patientName: row.patient_name,
    practiceName: ctx.practiceName,
    practiceAddress: ctx.practiceAddress,
  };
  switch (kind) {
    case "sample_sent":
      return React.createElement(SampleSent, {
        ...common,
        labName: row.lab_name,
        labPanel: row.lab_panel,
        turnaroundText: turnaroundTextFor(row),
      });
    case "partial_uploaded":
      return React.createElement(PartialUploaded, {
        ...common,
        labName: row.lab_name,
        labPanel: row.lab_panel,
      });
    case "complete_uploaded":
      return React.createElement(CompleteUploaded, {
        ...common,
        labName: row.lab_name,
        labPanel: row.lab_panel,
      });
    case "rof_followup":
      return React.createElement(RofFollowup, common);
  }
}

export async function renderEmail(
  row: LabCase,
  kind: EmailKind,
): Promise<RenderedEmail> {
  const ctx = envEmailConfig();
  const element = templateFor(kind, row, ctx);
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });

  const originalTo = row.patient_email;
  const isTestRedirect = Boolean(ctx.testRedirect);
  const to = isTestRedirect ? [ctx.testRedirect!] : [originalTo];
  const subject = isTestRedirect
    ? `[TEST → ${originalTo}] ${SUBJECT[kind]}`
    : SUBJECT[kind];

  const bccList = BCC_BY_KIND[kind];

  return {
    to,
    bcc: isTestRedirect || bccList.length === 0 ? undefined : bccList,
    from: ctx.fromHeader,
    replyTo: ctx.replyTo,
    subject,
    html,
    text,
    isTestRedirect,
    originalTo,
  };
}
