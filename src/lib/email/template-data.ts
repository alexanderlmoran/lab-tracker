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

/**
 * Suggested copy for per-lab overrides on first creation. Keyed by
 * "{kind}::{labName}". The Settings UI pre-fills the new-template form
 * with these when the admin picks a (lab, kind) pair we have a draft for —
 * so common per-lab variants (e.g. peptides shipments) are one click away
 * from being saved as a real DB-overridable template.
 */
export const SUGGESTED_LAB_OVERRIDES: Record<string, Pick<EmailTemplate, "subject" | "heading" | "paragraphs">> = {
  "sample_sent::Peptides": {
    subject: "Your peptides order — shipped",
    heading: null,
    paragraphs: [
      "Dear {patientFirstName},",
      "Your peptides order ({labPanel}) has been shipped.",
      "Detailed instructions for proper storage, reconstitution, and administration will be included inside the package — please read them carefully before your first dose.",
      `If you have any questions when the package arrives, call us at ${PRACTICE_PHONE} or simply reply to this email.`,
      "Thank you.",
    ],
  },
};

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
  id?: string;
  kind: string;
  trigger_lab_name?: string | null;
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

/**
 * One DB round-trip loading every email_templates row, grouped into two
 * maps: global (one per kind, trigger_lab_name IS NULL) and per-lab
 * (composite key `${kind}::${labName}`). The migration that introduced
 * `trigger_lab_name` is forward-compatible — if it hasn't been applied yet
 * the column select still works, we just won't see any per-lab rows.
 */
async function loadAllTemplateRows(): Promise<{
  globalByKind: Map<string, DbRow>;
  byKindLab: Map<string, DbRow>;
  allRows: DbRow[];
}> {
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("email_templates")
      .select("id, kind, trigger_lab_name, subject, heading, paragraphs, bcc, enabled");
    const rows = (data ?? []) as DbRow[];
    const globalByKind = new Map<string, DbRow>();
    const byKindLab = new Map<string, DbRow>();
    for (const r of rows) {
      const lab = (r.trigger_lab_name ?? "").trim();
      if (!lab) {
        globalByKind.set(r.kind, r);
      } else {
        byKindLab.set(`${r.kind}::${lab}`, r);
      }
    }
    return { globalByKind, byKindLab, allRows: rows };
  } catch {
    return {
      globalByKind: new Map(),
      byKindLab: new Map(),
      allRows: [],
    };
  }
}

/** Back-compat alias for callers that only need the global-by-kind map. */
async function loadGlobalTemplateRows(): Promise<Map<string, DbRow>> {
  const { globalByKind } = await loadAllTemplateRows();
  return globalByKind;
}

/** Centralized "is this kind currently enabled?" check. Default = true so
 * a missing row (template never customized) doesn't accidentally block sends.
 * Per-lab rows don't have an independent enabled flag — they inherit the
 * global kind's state. */
export async function isEmailKindEnabled(
  kind: EditableEmailKind,
): Promise<boolean> {
  try {
    const byKind = await loadGlobalTemplateRows();
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
  const byKind = await loadGlobalTemplateRows();
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
  const byKind = await loadGlobalTemplateRows();
  return {
    staff_invite: mergeTemplate("staff_invite", byKind.get("staff_invite") ?? null),
    password_reset: mergeTemplate(
      "password_reset",
      byKind.get("password_reset") ?? null,
    ),
  };
}

/**
 * Render-time template resolution for a specific case. Picks the per-lab
 * override when one exists for (kind, lab_name); otherwise falls back to
 * the global-by-kind template (which itself overlays the code default).
 */
export async function loadPatientTemplateForCase(
  kind: PatientEmailKind,
  labName: string,
): Promise<EmailTemplate> {
  const { globalByKind, byKindLab } = await loadAllTemplateRows();
  const lab = labName.trim();
  const specific = lab ? byKindLab.get(`${kind}::${lab}`) : null;
  if (specific) return mergeTemplate(kind, specific);
  return mergeTemplate(kind, globalByKind.get(kind) ?? null);
}

export type CustomEmailTemplateRow = {
  id: string;
  kind: PatientEmailKind;
  triggerLabName: string;
  template: EmailTemplate;
  isCustomised: true;
};

/** Lists every per-lab override row in the DB. Used by the settings UI to
 * render the "Custom per-lab templates" section. */
export async function listCustomEmailTemplates(): Promise<CustomEmailTemplateRow[]> {
  const { allRows } = await loadAllTemplateRows();
  const out: CustomEmailTemplateRow[] = [];
  for (const r of allRows) {
    if (!r.id || !r.trigger_lab_name) continue;
    if (!PATIENT_EMAIL_KINDS.includes(r.kind as PatientEmailKind)) continue;
    out.push({
      id: r.id,
      kind: r.kind as PatientEmailKind,
      triggerLabName: r.trigger_lab_name,
      template: mergeTemplate(r.kind as PatientEmailKind, r),
      isCustomised: true,
    });
  }
  out.sort((a, b) => {
    const labCmp = a.triggerLabName.localeCompare(b.triggerLabName);
    if (labCmp !== 0) return labCmp;
    return a.kind.localeCompare(b.kind);
  });
  return out;
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
