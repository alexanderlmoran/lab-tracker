// Internal-staff emails (Nadia outreach confirm, Allison ROF proofread).
// These are not part of the per-case patient pipeline in email-actions.ts —
// they have different recipient routing and different template props, so they
// live in their own module with their own dispatch helper.

import { render } from "@react-email/components";
import { Resend } from "resend";
import * as React from "react";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { AllisonRofReview, NadiaAllReceived } from "./templates";
import { loadEmailConfig, SUBJECT } from "./render";
import type { EmailKind, LabCase } from "@/lib/types";

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

import { appBaseUrl } from "@/lib/app-url";

function nadiaAddress(): string {
  return process.env.NADIA_EMAIL?.trim() || "nadia@centnerwellness.com";
}

function allisonAddress(): string {
  return process.env.ALLISON_EMAIL?.trim() || "allison@centnerwellness.com";
}

function labLabelFor(c: LabCase): string {
  return c.lab_panel ? `${c.lab_name} ${c.lab_panel}` : c.lab_name;
}

type DispatchResult = { ok: true; messageId?: string } | { ok: false; error: string };

async function dispatch(args: {
  caseIds: string[];
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<DispatchResult> {
  const { caseIds, kind, to, subject, html, text } = args;
  const ctx = await loadEmailConfig();
  const db = getSupabaseAdmin();

  // Test redirect: in non-prod environments, route to the redirect target
  // and prepend the real recipient to the subject. Keeps internal sends
  // from leaking to staff during local testing.
  const isTestRedirect = Boolean(ctx.testRedirect);
  const actualTo = isTestRedirect ? ctx.testRedirect! : to;
  const actualSubject = isTestRedirect ? `[TEST → ${to}] ${subject}` : subject;

  // Log per-case so the email shows up in each case's history.
  const queuedRows = await Promise.all(
    caseIds.map(async (caseId) => {
      const { data } = await db
        .from("email_logs")
        .insert({
          case_id: caseId,
          kind,
          status: "queued",
          to_address: to,
        })
        .select("id")
        .single();
      return data?.id ?? null;
    }),
  );

  let messageId: string | undefined;
  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: ctx.fromHeader,
      to: [actualTo],
      replyTo: ctx.replyTo,
      subject: actualSubject,
      html,
      text,
    });
    if (result.error) throw new Error(result.error.message);
    messageId = result.data?.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed";
    for (const id of queuedRows) {
      if (!id) continue;
      await db
        .from("email_logs")
        .update({ status: "failed", error_message: msg })
        .eq("id", id);
    }
    return { ok: false, error: msg };
  }

  for (const id of queuedRows) {
    if (!id) continue;
    await db
      .from("email_logs")
      .update({ status: "sent", resend_message_id: messageId ?? null })
      .eq("id", id);
  }

  return { ok: true, messageId };
}

export async function sendNadiaAllReceived(args: {
  cases: LabCase[];
  token: string;
}): Promise<DispatchResult> {
  if (args.cases.length === 0) return { ok: false, error: "No cases" };
  const ctx = await loadEmailConfig();
  const first = args.cases[0];
  const confirmUrl = `${appBaseUrl()}/api/nadia/confirm?token=${encodeURIComponent(args.token)}`;
  const element = React.createElement(NadiaAllReceived, {
    practiceName: ctx.practiceName,
    practiceAddress: ctx.practiceAddress,
    patientName: first.patient_name,
    labLabels: args.cases.map(labLabelFor),
    confirmUrl,
  });
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });
  return dispatch({
    caseIds: args.cases.map((c) => c.id),
    kind: "nadia_all_received",
    to: nadiaAddress(),
    subject: SUBJECT.nadia_all_received,
    html,
    text,
  });
}

export async function sendAllisonRofReview(args: {
  patientCases: LabCase[];
}): Promise<DispatchResult> {
  if (args.patientCases.length === 0) return { ok: false, error: "No cases" };
  const ctx = await loadEmailConfig();
  const first = args.patientCases[0];
  const base = appBaseUrl();
  const element = React.createElement(AllisonRofReview, {
    practiceName: ctx.practiceName,
    practiceAddress: ctx.practiceAddress,
    patientName: first.patient_name,
    patientEmail: first.patient_email,
    labLabels: args.patientCases.map(labLabelFor),
    caseUrls: args.patientCases.map((c) => `${base}/labs/${c.id}`),
  });
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });
  return dispatch({
    caseIds: args.patientCases.map((c) => c.id),
    kind: "rof_allison",
    to: allisonAddress(),
    subject: SUBJECT.rof_allison,
    html,
    text,
  });
}
