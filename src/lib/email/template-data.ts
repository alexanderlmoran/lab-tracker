// Editable per-kind defaults + DB-overlay layer for every email the app
// sends. Patient emails (4) plus staff emails (invite + password reset, 2)
// all live here. The internal "nadia_all_received" and "rof_allison"
// notifications stay hardcoded — those are workflow signaling, not copy
// staff want to tweak.
//
// Storage shape: paragraphs are a single text blob, blank-line separated.
// At render time we substitute {placeholders} against the case row + practice
// settings, then pass the array of strings into a generic React template.

import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { LabCase } from "@/lib/types";

export type PatientEmailKind =
  | "sample_sent"
  | "partial_uploaded"
  | "complete_uploaded"
  | "rof_followup";

export type StaffEmailKind = "staff_invite" | "password_reset";

export type EditableEmailKind = PatientEmailKind | StaffEmailKind;

export const PATIENT_EMAIL_KINDS: PatientEmailKind[] = [
  "sample_sent",
  "partial_uploaded",
  "complete_uploaded",
  "rof_followup",
];

export const STAFF_EMAIL_KINDS: StaffEmailKind[] = [
  "staff_invite",
  "password_reset",
];

export const KIND_LABEL: Record<EditableEmailKind, string> = {
  sample_sent: "1 · Sample sent",
  partial_uploaded: "2 · Partial results uploaded",
  complete_uploaded: "3 · Complete results uploaded",
  rof_followup: "4 · ROF follow-up",
  staff_invite: "Staff invite (sign-in / set password)",
  password_reset: "Password reset",
};

export type EmailTemplate = {
  kind: EditableEmailKind;
  subject: string;
  /** Optional heading rendered above the greeting. Currently only rof_followup uses one in defaults. */
  heading: string | null;
  /** Paragraph strings, rendered in order. May contain {placeholder} tokens. */
  paragraphs: string[];
  /** Operational BCC list — addresses that silently receive every send of this kind. */
  bcc: string[];
};

// Constants used inside template defaults — single source of truth for
// per-practice details that aren't yet configurable.
const PRACTICE_PHONE = "305-602-5260";
const PB_PORTAL = "practicebetter.io";

// Single source of truth for ALL editable email defaults — patient and
// staff alike. The DB-overlay only ever overrides individual fields; full
// fallback to these defaults if a kind has no row.
export const EMAIL_DEFAULTS: Record<EditableEmailKind, EmailTemplate> = {
  sample_sent: {
    kind: "sample_sent",
    subject: "Sample Received",
    heading: null,
    paragraphs: [
      "Dear {patientFirstName},",
      "Your sample has been sent to our partner laboratory for: {labLabel}.",
      "Results are expected within {turnaroundText}.",
      `Thank you and please call us at ${PRACTICE_PHONE} if you have any questions.`,
      "You can also reply to this email.",
    ],
    bcc: ["chrisc@centnerwellness.com", "info@centnerwellness.com"],
  },
  partial_uploaded: {
    kind: "partial_uploaded",
    subject: "Partial Results Received",
    heading: null,
    paragraphs: [
      "Dear {patientFirstName},",
      "We have received partial results for the following: {labLabel}.",
      "These results have been uploaded to Practice Better.",
      "We will notify you when the complete results become available.",
      `To view the partial results, please look for a separate email from Practice Better, or log in to: ${PB_PORTAL}`,
      `Thank you and please call us at ${PRACTICE_PHONE} if you have any questions.`,
      "You can also reply to this email.",
    ],
    bcc: ["chrisc@centnerwellness.com"],
  },
  complete_uploaded: {
    kind: "complete_uploaded",
    subject: "Complete Results Received",
    heading: null,
    paragraphs: [
      "Dear {patientFirstName},",
      "We have received the complete results for the following: {labLabel}.",
      "These results have been uploaded to Practice Better.",
      `To view the complete results, please look for a separate email from Practice Better, or log in to: ${PB_PORTAL}`,
      "If all of your labs have been received, you will receive a phone call from our patient coordinator Nadia who will assist in scheduling your virtual or in-person review of results with our practitioner.",
      `Thank you and please call us at ${PRACTICE_PHONE} if you have any questions.`,
      "You can also reply to this email.",
    ],
    bcc: ["chrisc@centnerwellness.com", "nadia@centnerwellness.com"],
  },
  rof_followup: {
    kind: "rof_followup",
    subject: "Thanks for your review — here's what's next",
    heading: "Thanks for your review — here's what's next",
    paragraphs: [
      "Dear {patientFirstName},",
      "Great catching up. As discussed, we'll send your protocol shortly, and a member of the team will follow up about supplements and anything else that came out of the review.",
      "If anything is unclear, reply here.",
    ],
    bcc: [],
  },
  staff_invite: {
    kind: "staff_invite",
    subject: "You've been invited to the Centner Wellness Lab Tracking App",
    heading: null,
    paragraphs: [
      "Hi {inviteeFirstName},",
      "You've been invited to the Centner Wellness Lab Tracking App. Click the link below to sign in and pick a password.",
      "{magicLink}",
      "This link expires soon. If it doesn't work, ask the admin who invited you for a fresh one.",
    ],
    bcc: [],
  },
  password_reset: {
    kind: "password_reset",
    subject: "Reset your Centner Wellness Lab Tracking App password",
    heading: null,
    paragraphs: [
      "Hi {inviteeFirstName},",
      "We received a request to reset your Centner Wellness Lab Tracking App password. Click the link below to choose a new one.",
      "{magicLink}",
      "If you didn't request this, you can ignore this email — your current password stays active.",
    ],
    bcc: [],
  },
};

type DbRow = {
  kind: string;
  subject: string | null;
  heading: string | null;
  paragraphs: string | null;
  bcc: string | null;
  enabled?: boolean | null;
};

function parseBccList(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const list = raw
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list;
}

function paragraphsFromBlob(blob: string | null | undefined): string[] | null {
  if (blob == null) return null;
  // Split on blank lines but preserve single-line breaks inside a paragraph.
  return blob
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Merge a DB override row over the code default. Empty/null DB fields keep
 * the default — partial overrides are allowed (e.g. override just the BCC). */
export function mergeTemplate(
  kind: EditableEmailKind,
  row: DbRow | null,
): EmailTemplate {
  const base = EMAIL_DEFAULTS[kind];
  if (!row) return base;
  const paragraphs = paragraphsFromBlob(row.paragraphs);
  const bcc = parseBccList(row.bcc);
  return {
    kind,
    subject: row.subject?.trim() || base.subject,
    heading:
      row.heading != null
        ? row.heading.trim() || null
        : base.heading,
    paragraphs: paragraphs && paragraphs.length > 0 ? paragraphs : base.paragraphs,
    bcc: bcc ?? base.bcc,
  };
}

async function loadAllTemplateRows(): Promise<Map<string, DbRow>> {
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("email_templates")
      .select("kind, subject, heading, paragraphs, bcc, enabled");
    return new Map(((data ?? []) as DbRow[]).map((r) => [r.kind, r]));
  } catch {
    // Table missing pre-migration — fall back to defaults.
    return new Map();
  }
}

/** Centralized "is this kind currently enabled?" check. Default = true so
 * a missing row (template never customized) doesn't accidentally block sends. */
export async function isEmailKindEnabled(
  kind: EditableEmailKind,
): Promise<boolean> {
  try {
    const byKind = await loadAllTemplateRows();
    const row = byKind.get(kind);
    if (!row) return true;
    return row.enabled !== false;
  } catch {
    return true;
  }
}

/** Load merged templates for every patient kind. One DB round-trip. */
export async function loadAllPatientTemplates(): Promise<
  Record<PatientEmailKind, EmailTemplate>
> {
  const byKind = await loadAllTemplateRows();
  return {
    sample_sent: mergeTemplate("sample_sent", byKind.get("sample_sent") ?? null),
    partial_uploaded: mergeTemplate(
      "partial_uploaded",
      byKind.get("partial_uploaded") ?? null,
    ),
    complete_uploaded: mergeTemplate(
      "complete_uploaded",
      byKind.get("complete_uploaded") ?? null,
    ),
    rof_followup: mergeTemplate(
      "rof_followup",
      byKind.get("rof_followup") ?? null,
    ),
  };
}

/** Load merged templates for every staff (admin) kind. */
export async function loadAllStaffTemplates(): Promise<
  Record<StaffEmailKind, EmailTemplate>
> {
  const byKind = await loadAllTemplateRows();
  return {
    staff_invite: mergeTemplate("staff_invite", byKind.get("staff_invite") ?? null),
    password_reset: mergeTemplate(
      "password_reset",
      byKind.get("password_reset") ?? null,
    ),
  };
}

export async function loadStaffTemplate(
  kind: StaffEmailKind,
): Promise<EmailTemplate> {
  const all = await loadAllStaffTemplates();
  return all[kind];
}

export async function loadPatientTemplate(
  kind: PatientEmailKind,
): Promise<EmailTemplate> {
  const all = await loadAllPatientTemplates();
  return all[kind];
}

/** Substitute {placeholder} tokens. Unknown tokens are left intact so an
 * authoring typo doesn't silently swallow visible characters. */
export function applyPlaceholders(
  text: string,
  ctx: Record<string, string | null | undefined>,
): string {
  return text.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = ctx[key];
    return v == null ? m : String(v);
  });
}

export function firstNameOf(fullName: string): string {
  const tok = fullName.trim().split(/\s+/)[0];
  return tok || fullName;
}

export function labLabelOf(row: Pick<LabCase, "lab_name" | "lab_panel">): string {
  return row.lab_panel ? `${row.lab_name} ${row.lab_panel}` : row.lab_name;
}
