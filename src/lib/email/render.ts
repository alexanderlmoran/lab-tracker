import { render } from "@react-email/components";
import * as React from "react";
import type { LabCase, EmailKind } from "@/lib/types";
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

const SUBJECT: Record<EmailKind, string> = {
  sample_sent: "Your sample is on its way to the lab",
  partial_uploaded: "Partial lab results are ready in your portal",
  complete_uploaded: "Your full lab results are ready",
  rof_followup: "Thanks for your review — here's what's next",
};

export function envEmailConfig() {
  const fromEmail = process.env.ALERT_FROM_EMAIL ?? "";
  const replyTo = process.env.REPLY_TO_EMAIL || undefined;
  const practiceName = stripQuotes(process.env.PRACTICE_NAME ?? "");
  const practiceAddress = stripQuotes(process.env.PRACTICE_MAILING_ADDRESS ?? "") || null;
  const portalUrl = process.env.PATIENT_PORTAL_URL || null;
  const bcc = (process.env.EMAIL_BCC ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    portalUrl,
    bcc,
    testRedirect,
  };
}

function stripQuotes(s: string) {
  return s.replace(/^['"](.+)['"]$/, "$1");
}

function templateFor(kind: EmailKind, row: LabCase, ctx: ReturnType<typeof envEmailConfig>) {
  const common = {
    patientName: row.patient_name,
    practiceName: ctx.practiceName,
    practiceAddress: ctx.practiceAddress,
    patientPortalUrl: ctx.portalUrl,
  };
  switch (kind) {
    case "sample_sent":
      return React.createElement(SampleSent, {
        ...common,
        labName: row.lab_name,
        trackingNumber: row.tracking_number,
      });
    case "partial_uploaded":
      return React.createElement(PartialUploaded, {
        ...common,
        labName: row.lab_name,
      });
    case "complete_uploaded":
      return React.createElement(CompleteUploaded, {
        ...common,
        labName: row.lab_name,
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

  return {
    to,
    bcc: isTestRedirect ? undefined : ctx.bcc.length ? ctx.bcc : undefined,
    from: ctx.fromHeader,
    replyTo: ctx.replyTo,
    subject,
    html,
    text,
    isTestRedirect,
    originalTo,
  };
}
