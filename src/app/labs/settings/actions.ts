"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Resend } from "resend";
import { hasRole, requireRole, type AppRole, type SessionUser } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { LAB_CATALOG } from "@/lib/labs/catalog";
import { invalidateEffectiveCatalogCache } from "@/lib/labs/effective";
import { loadEmailConfig, renderTestEmail } from "@/lib/email/render";
import {
  EMAIL_DEFAULTS,
  KIND_LABEL,
  PATIENT_EMAIL_KINDS,
  loadAllPatientTemplates,
  type EmailTemplate,
  type PatientEmailKind,
} from "@/lib/email/template-data";
import { appBaseUrl } from "@/lib/app-url";
import type { ActionResult } from "@/lib/types";

/** Send the magic-link invite via OUR Resend account rather than Supabase's
 * built-in SMTP. Supabase's default sender is rate-limited and only suitable
 * for development; for prod we need a domain we control. Returns the link
 * so the admin can copy it as a fallback if the email send fails. */
async function emailInviteLink(args: {
  toEmail: string;
  fullName: string | null;
  link: string;
  isNew: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };
  const ctx = await loadEmailConfig();
  const practice = ctx.practiceName || "the Lab Tracker";
  const greetingName = args.fullName?.split(/\s+/)[0] ?? "there";
  const cta = args.isNew
    ? "Click the link below to set your password and finish signing in."
    : "Click the link below to sign in.";

  const html = `
    <p>Hi ${escapeHtml(greetingName)},</p>
    <p>You've been invited to ${escapeHtml(practice)}. ${cta}</p>
    <p><a href="${args.link}">${args.link}</a></p>
    <p style="color:#6b7a8c;font-size:12px;">This link will expire. If it doesn't work, ask the admin who invited you for a fresh one.</p>
  `;
  const text = `Hi ${greetingName},\n\nYou've been invited to ${practice}. ${cta}\n\n${args.link}\n\nThis link will expire.`;

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from: ctx.fromHeader,
      to: [ctx.testRedirect ?? args.toEmail],
      replyTo: ctx.replyTo,
      subject: ctx.testRedirect
        ? `[TEST → ${args.toEmail}] You've been invited to ${practice}`
        : `You've been invited to ${practice}`,
      html,
      text,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── App settings ──────────────────────────────────────────────────────

const SETTING_KEYS = ["reply_to_email", "from_email", "practice_name"] as const;
export type AppSettingKey = (typeof SETTING_KEYS)[number];

export type AppSettings = Record<AppSettingKey, string | null>;

export async function getAppSettings(): Promise<AppSettings> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data } = await db.from("app_settings").select("key, value");
  const map: Record<string, string | null> = {};
  for (const row of (data ?? []) as Array<{ key: string; value: string | null }>) {
    map[row.key] = row.value;
  }
  const out = {} as AppSettings;
  for (const key of SETTING_KEYS) {
    out[key] = map[key] ?? null;
  }
  return out;
}

const SettingsInput = z.object({
  reply_to_email: z.string().trim().email().or(z.literal("")).transform((v) => v || null),
  from_email: z.string().trim().email().or(z.literal("")).transform((v) => v || null),
  practice_name: z.string().trim().max(200).or(z.literal("")).transform((v) => v || null),
});

export async function updateAppSettings(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");
  const parsed = SettingsInput.safeParse({
    reply_to_email: formData.get("reply_to_email") ?? "",
    from_email: formData.get("from_email") ?? "",
    practice_name: formData.get("practice_name") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const rows = (Object.entries(parsed.data) as Array<[AppSettingKey, string | null]>).map(
    ([key, value]) => ({ key, value, updated_by: user.id }),
  );
  const { error } = await db.from("app_settings").upsert(rows, { onConflict: "key" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

// ── User management ───────────────────────────────────────────────────

export type AppUserRow = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: AppRole;
  invited_at: string | null;
  created_at: string;
};

export async function listAppUsers(): Promise<AppUserRow[]> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("app_users")
    .select("user_id, email, full_name, role, invited_at, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AppUserRow[];
}

const InviteInput = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().max(200).or(z.literal("")).transform((v) => v || null),
  role: z.enum(["developer", "admin", "staff"]),
});

function assertCanGrant(actor: SessionUser, targetRole: AppRole) {
  if (targetRole === "developer" && !hasRole(actor, "developer")) {
    throw new Error("Only a developer can grant the developer role.");
  }
  if (!hasRole(actor, "admin")) {
    throw new Error("Admin role required.");
  }
}

export async function inviteAppUser(input: {
  email: string;
  fullName: string;
  role: AppRole;
}): Promise<
  ActionResult<{
    userId: string;
    /** Set when the email send failed — admin can copy/paste the link. */
    magicLink?: string | null;
    /** Human-readable note about the email send outcome. */
    note?: string;
  }>
> {
  const actor = await requireRole("admin");
  const parsed = InviteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    assertCanGrant(actor, parsed.data.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Forbidden" };
  }

  const db = getSupabaseAdmin();
  const redirectTo = `${appBaseUrl()}/labs`;
  let userId: string | null = null;
  let isNew = false;

  // 1) Create the auth.users row if missing. We use `inviteUserByEmail` for
  //    its convenient user-creation semantics, but we IGNORE Supabase's
  //    built-in email send — it relies on Supabase's default SMTP which
  //    is rate-limited and doesn't deliver reliably in prod.
  const { data: invited, error: inviteErr } = await db.auth.admin.inviteUserByEmail(
    parsed.data.email,
    { data: { full_name: parsed.data.fullName ?? null }, redirectTo },
  );
  if (!inviteErr && invited?.user?.id) {
    userId = invited.user.id;
    isNew = true;
  }

  // 2) Generate a magic-link URL we can email ourselves. Works for both the
  //    just-created user (gives them a sign-in link) and for existing users
  //    (the invite call above will have errored — that's expected).
  const linkType = isNew ? "invite" : "magiclink";
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: linkType,
    email: parsed.data.email,
    options: { redirectTo },
  });
  if (linkErr || !link?.user?.id) {
    return {
      ok: false,
      error: (inviteErr ?? linkErr)?.message ?? "Could not generate magic link",
    };
  }
  userId = link.user.id;
  const actionLink = link.properties?.action_link ?? null;

  // 3) Send the link via our own Resend account so it comes from a domain
  //    we control. If sending fails (e.g. RESEND_API_KEY missing in dev),
  //    return the link to the admin so they can copy/paste it manually.
  let note: string | undefined;
  let magicLinkToSurface: string | null = null;
  if (actionLink) {
    const send = await emailInviteLink({
      toEmail: parsed.data.email,
      fullName: parsed.data.fullName,
      link: actionLink,
      isNew,
    });
    if (!send.ok) {
      magicLinkToSurface = actionLink;
      note = `Invite email failed to send (${send.error}). Copy the link below and share it manually.`;
    } else {
      note = `Invite email sent to ${parsed.data.email}.`;
    }
  }

  await db.from("app_users").upsert(
    {
      user_id: userId,
      email: parsed.data.email,
      full_name: parsed.data.fullName,
      role: parsed.data.role,
      invited_by: actor.id,
      invited_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  revalidatePath("/labs/settings");
  return { ok: true, data: { userId, magicLink: magicLinkToSurface, note } };
}

const RoleInput = z.object({
  userId: z.string().uuid(),
  role: z.enum(["developer", "admin", "staff"]),
});

export async function setAppUserRole(input: {
  userId: string;
  role: AppRole;
}): Promise<ActionResult> {
  const actor = await requireRole("admin");
  const parsed = RoleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    assertCanGrant(actor, parsed.data.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Forbidden" };
  }

  if (parsed.data.userId === actor.id && parsed.data.role !== "developer") {
    // Stop a developer from accidentally demoting themselves into a lockout.
    return { ok: false, error: "You can't demote yourself." };
  }

  const db = getSupabaseAdmin();
  const { error } = await db
    .from("app_users")
    .update({ role: parsed.data.role })
    .eq("user_id", parsed.data.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function regenerateInviteLink(input: {
  email: string;
}): Promise<
  ActionResult<{ magicLink: string | null; note?: string }>
> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const redirectTo = `${appBaseUrl()}/labs`;

  // Look up display name so the email can greet them properly.
  const { data: appUser } = await db
    .from("app_users")
    .select("full_name")
    .eq("email", input.email)
    .maybeSingle();

  const { data: link, error } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: input.email,
    options: { redirectTo },
  });
  if (error || !link) return { ok: false, error: error?.message ?? "No link" };

  const actionLink = link.properties?.action_link ?? null;
  let note: string | undefined;
  let magicLinkToSurface: string | null = null;

  if (actionLink) {
    const send = await emailInviteLink({
      toEmail: input.email,
      fullName: (appUser?.full_name as string | null) ?? null,
      link: actionLink,
      isNew: false,
    });
    if (!send.ok) {
      magicLinkToSurface = actionLink;
      note = `Email failed to send (${send.error}). Copy this link instead.`;
    } else {
      note = `Magic link re-sent to ${input.email}.`;
    }
  }

  return { ok: true, data: { magicLink: magicLinkToSurface, note } };
}

export async function deleteAppUser(input: {
  userId: string;
}): Promise<ActionResult> {
  const actor = await requireRole("admin");
  if (input.userId === actor.id) {
    return { ok: false, error: "You can't delete your own account." };
  }
  const db = getSupabaseAdmin();
  // Cascade: app_users row gets removed automatically by auth.users delete.
  const { error } = await db.auth.admin.deleteUser(input.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

// ── Labs catalog (DB-backed) ──────────────────────────────────────────

export type LabsCatalogRow = {
  id: string;
  name: string;
  provider: string;
  panel: string | null;
  turnaround_days_min: number | null;
  turnaround_days_max: number | null;
  retired: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export async function listLabsCatalog(): Promise<LabsCatalogRow[]> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("labs_catalog")
    .select("*")
    .order("provider", { ascending: true })
    .order("panel", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as LabsCatalogRow[];
}

const LabInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(100),
  panel: z.string().trim().max(200).or(z.literal("")).transform((v) => v || null),
  turnaround_days_min: z.coerce.number().int().min(0).max(365).or(z.literal("")).optional(),
  turnaround_days_max: z.coerce.number().int().min(0).max(365).or(z.literal("")).optional(),
  retired: z.boolean().default(false),
  notes: z.string().trim().max(1000).or(z.literal("")).transform((v) => v || null),
});

export async function upsertLab(formData: FormData): Promise<ActionResult<{ id: string }>> {
  await requireRole("admin");
  const raw = {
    id: (formData.get("id") as string | null) || undefined,
    name: formData.get("name") ?? "",
    provider: formData.get("provider") ?? "",
    panel: formData.get("panel") ?? "",
    turnaround_days_min: formData.get("turnaround_days_min") ?? "",
    turnaround_days_max: formData.get("turnaround_days_max") ?? "",
    retired: formData.get("retired") === "on",
    notes: formData.get("notes") ?? "",
  };
  const parsed = LabInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...rest } = parsed.data;
  const row = {
    ...rest,
    turnaround_days_min:
      rest.turnaround_days_min === "" || rest.turnaround_days_min === undefined
        ? null
        : (rest.turnaround_days_min as number),
    turnaround_days_max:
      rest.turnaround_days_max === "" || rest.turnaround_days_max === undefined
        ? null
        : (rest.turnaround_days_max as number),
  };

  const db = getSupabaseAdmin();
  if (id) {
    const { error } = await db.from("labs_catalog").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
    invalidateEffectiveCatalogCache();
    revalidatePath("/labs/settings");
    return { ok: true, data: { id } };
  }

  const { data, error } = await db
    .from("labs_catalog")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };
  invalidateEffectiveCatalogCache();
  revalidatePath("/labs/settings");
  return { ok: true, data: { id: data.id } };
}

export async function deleteLab(input: { id: string }): Promise<ActionResult> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { error } = await db.from("labs_catalog").delete().eq("id", input.id);
  if (error) return { ok: false, error: error.message };
  invalidateEffectiveCatalogCache();
  revalidatePath("/labs/settings");
  return { ok: true };
}

/** Seed from the code catalog. Inserts only labs whose `name` isn't already
 * present — safe to re-run. Used on first setup to populate the editor. */
export async function seedLabsCatalogFromCode(): Promise<
  ActionResult<{ inserted: number }>
> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data: existing } = await db.from("labs_catalog").select("name");
  const have = new Set(
    ((existing ?? []) as Array<{ name: string }>).map((r) => r.name),
  );
  const toInsert = LAB_CATALOG.filter((e) => !have.has(e.name)).map((e) => ({
    name: e.name,
    provider: e.provider,
    panel: e.panel,
    turnaround_days_min: e.turnaroundDaysMin,
    turnaround_days_max: e.turnaroundDaysMax,
    retired: Boolean(e.retired),
    notes: null,
  }));
  if (toInsert.length === 0) {
    return { ok: true, data: { inserted: 0 } };
  }
  const { error } = await db.from("labs_catalog").insert(toInsert);
  if (error) return { ok: false, error: error.message };
  invalidateEffectiveCatalogCache();
  revalidatePath("/labs/settings");
  return { ok: true, data: { inserted: toInsert.length } };
}

// ── Email templates (DB-overridable patient copy) ─────────────────────

export type EmailTemplateRow = {
  kind: PatientEmailKind;
  label: string;
  subject: string;
  heading: string | null;
  paragraphs: string[];
  bcc: string[];
  isCustomised: boolean;
};

function buildRow(
  kind: PatientEmailKind,
  effective: EmailTemplate,
): EmailTemplateRow {
  const def = EMAIL_DEFAULTS[kind];
  const isCustomised =
    effective.subject !== def.subject ||
    effective.heading !== def.heading ||
    effective.paragraphs.join("\n\n") !== def.paragraphs.join("\n\n") ||
    effective.bcc.join(",") !== def.bcc.join(",");
  return {
    kind,
    label: KIND_LABEL[kind],
    subject: effective.subject,
    heading: effective.heading,
    paragraphs: effective.paragraphs,
    bcc: effective.bcc,
    isCustomised,
  };
}

export async function listEmailTemplates(): Promise<EmailTemplateRow[]> {
  await requireRole("admin");
  const all = await loadAllPatientTemplates();
  return PATIENT_EMAIL_KINDS.map((kind) => buildRow(kind, all[kind]));
}

const TemplateUpdate = z.object({
  kind: z.enum([
    "sample_sent",
    "partial_uploaded",
    "complete_uploaded",
    "rof_followup",
  ]),
  subject: z.string().trim().max(200),
  heading: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  paragraphs: z.string().trim().max(8000),
  bcc: z.string().trim().max(2000),
});

export async function updateEmailTemplate(input: {
  kind: PatientEmailKind;
  subject: string;
  heading: string;
  paragraphs: string;
  bcc: string;
}): Promise<ActionResult> {
  const actor = await requireRole("admin");
  const parsed = TemplateUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { error } = await db.from("email_templates").upsert(
    {
      kind: parsed.data.kind,
      subject: parsed.data.subject || null,
      heading: parsed.data.heading,
      paragraphs: parsed.data.paragraphs || null,
      bcc: parsed.data.bcc || null,
      updated_by: actor.id,
    },
    { onConflict: "kind" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function resetEmailTemplate(input: {
  kind: PatientEmailKind;
}): Promise<ActionResult> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("email_templates")
    .delete()
    .eq("kind", input.kind);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

const TestSendInput = z.object({
  kind: z.enum([
    "sample_sent",
    "partial_uploaded",
    "complete_uploaded",
    "rof_followup",
  ]),
  toEmail: z.string().trim().email(),
});

export async function sendTestEmail(input: {
  kind: PatientEmailKind;
  toEmail: string;
}): Promise<ActionResult<{ messageId?: string }>> {
  await requireRole("admin");
  const parsed = TestSendInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };

  const rendered = await renderTestEmail({
    kind: parsed.data.kind,
    toEmail: parsed.data.toEmail,
  });
  try {
    const result = await new Resend(key).emails.send({
      from: rendered.from,
      to: rendered.to,
      replyTo: rendered.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, data: { messageId: result.data?.id } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Send failed",
    };
  }
}
