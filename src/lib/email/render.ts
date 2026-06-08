import { render } from "@react-email/components";
import * as React from "react";
import type { LabCase, EmailKind } from "@/lib/types";
import { getEffectiveLab } from "@/lib/labs/effective";
import { PatientEmail } from "./templates";
import {
  applyPlaceholders,
  firstNameOf,
  labLabelOf,
  loadPatientTemplateForCase,
  type EmailTemplate,
  type PatientEmailKind,
} from "./template-data";

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

// Subject lines for internal (non-patient) email kinds — patient-kind
// subjects now live in template-data.ts so they're DB-overridable from
// /labs/settings → Email templates.
export const INTERNAL_SUBJECT: Record<
  "nadia_all_received" | "rof_allison" | "stale_digest" | "rof_reminder",
  string
> = {
  nadia_all_received: "All labs received — please confirm scheduling outreach",
  rof_allison: "ROF booked — please proofread",
  stale_digest: "Lab Tracker — daily stale-case digest",
  rof_reminder: "Lab Tracker — ROF scheduling reminder",
};

// Back-compat alias for src/lib/email/internal.ts which imports `SUBJECT`.
// Once that path is updated this export can be deleted.
export const SUBJECT = INTERNAL_SUBJECT;

export function envEmailConfig(overrides?: {
  fromEmail?: string | null;
  replyTo?: string | null;
  practiceName?: string | null;
}) {
  const fromEmail =
    overrides?.fromEmail?.trim() || process.env.ALERT_FROM_EMAIL || "";
  const replyTo =
    overrides?.replyTo?.trim() || process.env.REPLY_TO_EMAIL || undefined;
  const practiceName = stripQuotes(
    overrides?.practiceName?.trim() || process.env.PRACTICE_NAME || "",
  );
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

/** Load env config merged with any DB overrides from app_settings. Used by
 * server-side dispatch paths. Falls back to env-only if the table is empty
 * or unreachable so a fresh install keeps working. */
export async function loadEmailConfig() {
  try {
    const { getSupabaseAdmin } = await import("@/utils/supabase/admin");
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", ["from_email", "reply_to_email", "practice_name"]);
    const map: Record<string, string | null> = {};
    for (const row of (data ?? []) as Array<{ key: string; value: string | null }>) {
      map[row.key] = row.value;
    }
    return envEmailConfig({
      fromEmail: map.from_email,
      replyTo: map.reply_to_email,
      practiceName: map.practice_name,
    });
  } catch {
    return envEmailConfig();
  }
}

function stripQuotes(s: string) {
  return s.replace(/^['"](.+)['"]$/, "$1");
}

async function turnaroundTextFor(row: LabCase): Promise<string> {
  const lookupKey = row.lab_panel
    ? `${row.lab_name} ${row.lab_panel}`
    : row.lab_name;
  const entry =
    (await getEffectiveLab(lookupKey)) ??
    (await getEffectiveLab(row.lab_name));
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

function placeholderContext(
  row: LabCase,
  ctx: ReturnType<typeof envEmailConfig>,
  turnaroundText: string,
): Record<string, string> {
  return {
    patientName: row.patient_name,
    patientFirstName: firstNameOf(row.patient_name),
    labName: row.lab_name,
    labPanel: row.lab_panel ?? "",
    labLabel: labLabelOf(row),
    turnaroundText,
    practiceName: ctx.practiceName,
  };
}

function renderTemplateElement(
  template: EmailTemplate,
  ctx: ReturnType<typeof envEmailConfig>,
  placeholders: Record<string, string>,
) {
  const heading = template.heading
    ? applyPlaceholders(template.heading, placeholders)
    : null;
  const paragraphs = template.paragraphs.map((p) =>
    applyPlaceholders(p, placeholders),
  );
  const subject = applyPlaceholders(template.subject, placeholders);
  return {
    element: React.createElement(PatientEmail, {
      preview: subject,
      heading,
      paragraphs,
      practiceName: ctx.practiceName,
      practiceAddress: ctx.practiceAddress,
    }),
    subject,
  };
}

export async function renderEmail(
  row: LabCase,
  kind: EmailKind,
): Promise<RenderedEmail> {
  if (kind === "nadia_all_received" || kind === "rof_allison") {
    throw new Error(
      `Internal email kind '${kind}' must be dispatched via src/lib/email/internal.ts, not renderEmail.`,
    );
  }
  const patientKind = kind as PatientEmailKind;

  // Per-lab overrides (email_templates rows with trigger_lab_name) win over
  // the global template; loadPatientTemplateForCase encapsulates that
  // fallback chain.
  const [ctx, template, turnaroundText] = await Promise.all([
    loadEmailConfig(),
    loadPatientTemplateForCase(patientKind, row.lab_name),
    patientKind === "sample_sent" ? turnaroundTextFor(row) : Promise.resolve(""),
  ]);
  const placeholders = placeholderContext(row, ctx, turnaroundText);
  const { element, subject } = renderTemplateElement(template, ctx, placeholders);
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });

  const originalTo = row.patient_email;
  const isTestRedirect = Boolean(ctx.testRedirect);
  const to = isTestRedirect ? [ctx.testRedirect!] : [originalTo];
  const finalSubject = isTestRedirect
    ? `[TEST → ${originalTo}] ${subject}`
    : subject;

  const bccList = template.bcc;

  return {
    to,
    bcc: isTestRedirect || bccList.length === 0 ? undefined : bccList,
    from: ctx.fromHeader,
    replyTo: ctx.replyTo,
    subject: finalSubject,
    html,
    text,
    isTestRedirect,
    originalTo,
  };
}

/** Render a template against a fake patient row — used by the "Send test"
 * button in /labs/settings → Email templates so admins can preview without
 * a real case. */
export async function renderTestEmail(args: {
  kind: PatientEmailKind;
  toEmail: string;
  /** When set, picks the per-lab override for this lab (if one exists) and
   * the fake case row reflects the same lab + a placeholder panel so the
   * preview reads naturally. Used by the Settings "Send test" button on a
   * per-lab template card. */
  triggerLabName?: string | null;
}): Promise<RenderedEmail> {
  const ctx = await loadEmailConfig();
  const lab = args.triggerLabName?.trim() || "Access";
  const samplePanel =
    lab === "Access"
      ? "Blood Panel"
      : lab === "Peptides"
      ? "BPC-157"
      : "(sample panel)";

  const sampleRow: LabCase = {
    id: "00000000-0000-0000-0000-000000000000",
    patient_name: "Sample Patient",
    patient_email: args.toEmail,
    patient_phone: null,
    patient_dob: null,
    patient_address: null,
    lab_name: lab,
    lab_panel: samplePanel,
    tracking_number: null,
    lab_external_ref: null,
    pickup_confirmation: null,
    collection_date: null,
    partial_expected: false,
    auto_send_emails: true,
    notes: null,
    step1_sample_sent: true,
    step2_partial_received: false,
    step3_partial_uploaded: false,
    step4_complete_received: false,
    step5_complete_uploaded: false,
    step6_rof_scheduled: false,
    step7_rof_completed: false,
    step8_protocol_emailed: false,
    step9_sales_followup: false,
    archived_at: null,
    deleted_at: null,
    expected_result_at_min: null,
    expected_result_at_max: null,
    bulk_import_id: null,
    zenoti_appointment_id: null,
    zenoti_guest_id: null,
    zenoti_service_name: null,
    tracking_carrier: null,
    tracking_status: null,
    tracking_status_detail: null,
    tracking_event_at: null,
    tracking_polled_at: null,
    tracking_delivered_at: null,
    tracking_location: null,
    pickup_scheduled_date: null,
    pickup_carrier: null,
    nadia_confirm_token: null,
    nadia_confirm_sent_at: null,
    nadia_confirm_expires_at: null,
    nadia_confirmed_at: null,
    allison_rof_emailed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const template = await loadPatientTemplateForCase(args.kind, lab);
  const turnaroundText =
    args.kind === "sample_sent" ? await turnaroundTextFor(sampleRow) : "";
  const placeholders = placeholderContext(sampleRow, ctx, turnaroundText);
  const { element, subject } = renderTemplateElement(template, ctx, placeholders);
  const html = await render(element, { pretty: false });
  const text = await render(element, { plainText: true });

  return {
    to: [args.toEmail],
    bcc: undefined,
    from: ctx.fromHeader,
    replyTo: ctx.replyTo,
    subject: `[TEST] ${subject}`,
    html,
    text,
    isTestRedirect: true,
    originalTo: args.toEmail,
  };
}
