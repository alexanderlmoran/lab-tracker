"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Resend } from "resend";
import { hasRole, requireRole, type AppRole, type SessionUser } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { LAB_CATALOG } from "@/lib/labs/catalog";
import { invalidateEffectiveCatalogCache } from "@/lib/labs/effective";
import { LAB_PORTALS } from "@/lib/inbound/detect-notification";
import {
  invalidateLabPortalsCache,
  listLabPortalsFromDb,
  type LabPortalRow,
} from "@/lib/lab-portals/server";
import { renderTestEmail } from "@/lib/email/render";
import {
  EMAIL_DEFAULTS,
  KIND_LABEL,
  PATIENT_EMAIL_KINDS,
  STAFF_EMAIL_KINDS,
  SUGGESTED_LAB_OVERRIDES,
  listCustomEmailTemplates,
  loadAllPatientTemplates,
  loadAllStaffTemplates,
  type EditableEmailKind,
  type EmailTemplate,
  type PatientEmailKind,
  type StaffEmailKind,
} from "@/lib/email/template-data";
import { sendStaffEmail } from "@/lib/email/staff-sender";
import { appBaseUrl } from "@/lib/app-url";
import type { ActionResult } from "@/lib/types";

// ── App settings ──────────────────────────────────────────────────────

const SETTING_KEYS = [
  "reply_to_email",
  "from_email",
  "practice_name",
  "digest_email",
] as const;
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
  digest_email: z.string().trim().email().or(z.literal("")).transform((v) => v || null),
});

export async function updateAppSettings(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");
  const parsed = SettingsInput.safeParse({
    reply_to_email: formData.get("reply_to_email") ?? "",
    from_email: formData.get("from_email") ?? "",
    practice_name: formData.get("practice_name") ?? "",
    digest_email: formData.get("digest_email") ?? "",
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
  // Invitees land on /auth/set-password (with the magic-link session already
  // established via /auth/callback) so they pick a password before /labs.
  const redirectTo = `${appBaseUrl()}/auth/callback?next=${encodeURIComponent("/auth/set-password?next=/labs")}`;
  let userId: string | null = null;
  let isNew = false;

  // 1) Create the auth.users row (pre-confirmed so they don't need a
  //    separate email-verification step). createUser does NOT send any
  //    email — that's the key: previously we used inviteUserByEmail which
  //    auto-fires through Supabase's own SMTP and produced a second magic
  //    link with a different token that competed with ours. Single token,
  //    single email path now.
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: parsed.data.email,
    email_confirm: true,
    user_metadata: { full_name: parsed.data.fullName ?? null },
  });
  if (!createErr && created?.user?.id) {
    userId = created.user.id;
    isNew = true;
  } else if (createErr) {
    // Most common non-fatal: "User already registered". We continue to
    // generateLink and email a fresh magic link to whoever the existing
    // user is — same flow as the "regenerate magic link" button.
    const msg = createErr.message.toLowerCase();
    const isAlreadyExists =
      msg.includes("already") || msg.includes("registered") || msg.includes("duplicate");
    if (!isAlreadyExists) {
      return { ok: false, error: createErr.message };
    }
  }

  // 2) Generate a magic-link URL. With email_confirm:true above (or the
  //    pre-existing user case), `magiclink` is the right type — it's a
  //    sign-in link, not an email-verification link.
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: parsed.data.email,
    options: { redirectTo },
  });
  if (linkErr || !link?.user?.id) {
    return {
      ok: false,
      error: linkErr?.message ?? "Could not generate magic link",
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
    const send = await sendStaffEmail({
      kind: "staff_invite",
      toEmail: parsed.data.email,
      fullName: parsed.data.fullName,
      magicLink: actionLink,
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
  const redirectTo = `${appBaseUrl()}/auth/callback?next=${encodeURIComponent("/auth/set-password?next=/labs")}`;

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
    const send = await sendStaffEmail({
      kind: "staff_invite",
      toEmail: input.email,
      fullName: (appUser?.full_name as string | null) ?? null,
      magicLink: actionLink,
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

// Avoids ambiguous characters (0/O/1/l/I) so the admin can read it aloud.
const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generateTempPassword(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

const TempPasswordInput = z.object({
  userId: z.string().uuid(),
});

/** Set a fresh random password on a user and return it so the admin can read
 * it out to them. Use when the magic-link flow didn't work for the user — they
 * sign in with email + this password, then change it at /labs/account. */
export async function setTempPassword(input: {
  userId: string;
}): Promise<ActionResult<{ password: string; email: string }>> {
  await requireRole("admin");
  const parsed = TempPasswordInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { data: appUser, error: lookupErr } = await db
    .from("app_users")
    .select("email")
    .eq("user_id", parsed.data.userId)
    .maybeSingle();
  if (lookupErr || !appUser?.email) {
    return { ok: false, error: "User not found." };
  }
  const password = generateTempPassword();
  const { error } = await db.auth.admin.updateUserById(parsed.data.userId, {
    password,
    email_confirm: true,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: { password, email: appUser.email as string } };
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
  partial_expected: boolean;
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
  partial_expected: z.boolean().default(false),
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
    partial_expected: formData.get("partial_expected") === "on",
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
    partial_expected: Boolean(e.partialExpected),
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

// ── Lab portals (DB-backed, editable) ─────────────────────────────────

export type { LabPortalRow } from "@/lib/lab-portals/server";

export async function listLabPortals(): Promise<LabPortalRow[]> {
  await requireRole("admin");
  return listLabPortalsFromDb();
}

const PortalInput = z.object({
  id: z.string().uuid().optional(),
  lab_key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(1000),
  audience: z
    .enum(["patient", "provider"])
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v)),
  sort_order: z.coerce.number().int().min(0).max(1000).default(0),
  notes: z
    .string()
    .trim()
    .max(1000)
    .or(z.literal(""))
    .transform((v) => v || null),
});

export async function upsertLabPortal(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  await requireRole("admin");
  const raw = {
    id: (formData.get("id") as string | null) || undefined,
    lab_key: formData.get("lab_key") ?? "",
    label: formData.get("label") ?? "",
    url: formData.get("url") ?? "",
    audience: formData.get("audience") ?? "",
    sort_order: formData.get("sort_order") ?? 0,
    notes: formData.get("notes") ?? "",
  };
  const parsed = PortalInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { id, ...row } = parsed.data;
  const db = getSupabaseAdmin();
  if (id) {
    const { error } = await db.from("lab_portals").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
    invalidateLabPortalsCache();
    revalidatePath("/labs/settings");
    return { ok: true, data: { id } };
  }
  const { data, error } = await db
    .from("lab_portals")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  invalidateLabPortalsCache();
  revalidatePath("/labs/settings");
  return { ok: true, data: { id: data.id } };
}

export async function deleteLabPortal(input: {
  id: string;
}): Promise<ActionResult> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { error } = await db.from("lab_portals").delete().eq("id", input.id);
  if (error) return { ok: false, error: error.message };
  invalidateLabPortalsCache();
  revalidatePath("/labs/settings");
  return { ok: true };
}

/** First-run helper: copies the code constant into the DB so admins have
 * something to edit. Skips lab_key+url pairs already present so it's safe
 * to re-run. */
export async function seedLabPortalsFromCode(): Promise<
  ActionResult<{ inserted: number }>
> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data: existing } = await db
    .from("lab_portals")
    .select("lab_key, url");
  const have = new Set(
    ((existing ?? []) as Array<{ lab_key: string; url: string }>).map(
      (r) => `${r.lab_key}::${r.url}`,
    ),
  );
  const toInsert = LAB_PORTALS.filter(
    (p) => !have.has(`${p.key}::${p.url}`),
  ).map((p, i) => ({
    lab_key: p.key,
    label: p.label,
    url: p.url,
    audience: p.audience ?? null,
    sort_order: i,
    notes: null,
  }));
  if (toInsert.length === 0) {
    return { ok: true, data: { inserted: 0 } };
  }
  const { error } = await db.from("lab_portals").insert(toInsert);
  if (error) return { ok: false, error: error.message };
  invalidateLabPortalsCache();
  revalidatePath("/labs/settings");
  return { ok: true, data: { inserted: toInsert.length } };
}

// ── Email templates (DB-overridable copy — patient + staff) ───────────

export type EmailTemplateGroup = "patient" | "staff";

export type EmailTemplateRow = {
  /** Row id when the underlying record is a per-lab override; null for the
   * global-per-kind row (which is identified by `kind` alone). */
  id: string | null;
  kind: EditableEmailKind;
  group: EmailTemplateGroup;
  /** Set on per-lab override rows; null on the global rows. */
  triggerLabName: string | null;
  label: string;
  subject: string;
  heading: string | null;
  paragraphs: string[];
  bcc: string[];
  /** Placeholder tokens valid in this template — surfaced to the UI so the
   * help text lists the right ones per email. */
  placeholders: string[];
  isCustomised: boolean;
  /** When false, the email send path skips dispatch (logs a skipped event).
   * Only meaningful on global rows; per-lab rows always inherit. */
  enabled: boolean;
};

const PLACEHOLDERS_BY_GROUP: Record<EmailTemplateGroup, string[]> = {
  patient: [
    "{patientFirstName}",
    "{patientName}",
    "{labName}",
    "{labPanel}",
    "{labLabel}",
    "{turnaroundText}",
    "{practiceName}",
  ],
  staff: [
    "{inviteeFirstName}",
    "{inviteeName}",
    "{inviteeEmail}",
    "{practiceName}",
    "{magicLink}",
  ],
};

function buildRow(
  kind: EditableEmailKind,
  effective: EmailTemplate,
  group: EmailTemplateGroup,
  enabled: boolean,
): EmailTemplateRow {
  const def = EMAIL_DEFAULTS[kind];
  const isCustomised =
    effective.subject !== def.subject ||
    effective.heading !== def.heading ||
    effective.paragraphs.join("\n\n") !== def.paragraphs.join("\n\n") ||
    effective.bcc.join(",") !== def.bcc.join(",");
  return {
    id: null,
    kind,
    group,
    triggerLabName: null,
    label: KIND_LABEL[kind],
    subject: effective.subject,
    heading: effective.heading,
    paragraphs: effective.paragraphs,
    bcc: effective.bcc,
    placeholders: PLACEHOLDERS_BY_GROUP[group],
    isCustomised,
    enabled,
  };
}

export async function listEmailTemplates(): Promise<EmailTemplateRow[]> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const [patient, staff, enabledRows, customRows] = await Promise.all([
    loadAllPatientTemplates(),
    loadAllStaffTemplates(),
    db
      .from("email_templates")
      .select("kind, enabled, trigger_lab_name"),
    listCustomEmailTemplates(),
  ]);
  const enabledByKind = new Map<string, boolean>();
  for (const r of (enabledRows.data ?? []) as Array<{
    kind: string;
    enabled: boolean | null;
    trigger_lab_name: string | null;
  }>) {
    // Only the global (trigger_lab_name IS NULL) row carries the kind-level
    // enabled flag; per-lab rows inherit it.
    if (r.trigger_lab_name == null && r.kind != null) {
      enabledByKind.set(r.kind, r.enabled !== false);
    }
  }
  const isEnabled = (k: EditableEmailKind) =>
    enabledByKind.has(k) ? enabledByKind.get(k)! : true;

  const globals: EmailTemplateRow[] = [
    ...PATIENT_EMAIL_KINDS.map((k) =>
      buildRow(k, patient[k], "patient", isEnabled(k)),
    ),
    ...STAFF_EMAIL_KINDS.map((k) =>
      buildRow(k, staff[k], "staff", isEnabled(k)),
    ),
  ];

  const customs: EmailTemplateRow[] = customRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    group: "patient" as EmailTemplateGroup,
    triggerLabName: r.triggerLabName,
    label: `${KIND_LABEL[r.kind]} — ${r.triggerLabName}`,
    subject: r.template.subject,
    heading: r.template.heading,
    paragraphs: r.template.paragraphs,
    bcc: r.template.bcc,
    placeholders: PLACEHOLDERS_BY_GROUP.patient,
    isCustomised: true,
    enabled: isEnabled(r.kind),
  }));

  return [...globals, ...customs];
}

/** A (kind, lab) pair to seed the "Add custom template" form with — the UI
 * uses this to surface "BPC-suggestions" before the admin types anything. */
export type CustomTemplateSuggestion = {
  kind: PatientEmailKind;
  triggerLabName: string;
  subject: string;
  heading: string | null;
  paragraphs: string[];
};

/** Surface every email address the app has previously used — staff accounts,
 * existing BCC lists, and the configured reply-to / from / digest addresses.
 * The settings UI feeds this into a <datalist> so BCC inputs autocomplete
 * to addresses that are already known good (and catches typos like
 * "cetnerwellness" when the right answer is one keystroke away). */
export async function listKnownEmailAddresses(): Promise<string[]> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const part of raw.split(/[,\n;]/)) {
      const v = part.trim();
      if (!v) continue;
      // Loose validity — must look like an email — to avoid surfacing junk.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) continue;
      seen.add(v.toLowerCase());
    }
  };

  // Existing BCC lists on every email_templates row.
  try {
    const { data } = await db.from("email_templates").select("bcc");
    for (const r of (data ?? []) as Array<{ bcc: string | null }>) {
      add(r.bcc);
    }
  } catch {
    // Pre-migration or transient — fall through.
  }

  // Staff accounts (invited users).
  try {
    const { data } = await db.from("app_users").select("email");
    for (const r of (data ?? []) as Array<{ email: string | null }>) {
      add(r.email);
    }
  } catch {
    // Ignore.
  }

  // Configured email-shaped app_settings (reply_to_email, from_email, digest_email).
  try {
    const { data } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", ["reply_to_email", "from_email", "digest_email"]);
    for (const r of (data ?? []) as Array<{
      key: string;
      value: string | null;
    }>) {
      add(r.value);
    }
  } catch {
    // Ignore.
  }

  // Also surface the defaults the app ships with so a fresh install isn't
  // empty before any customization has happened.
  for (const def of Object.values(EMAIL_DEFAULTS)) {
    for (const b of def.bcc) add(b);
  }

  return Array.from(seen).sort();
}

export async function listCustomTemplateSuggestions(): Promise<CustomTemplateSuggestion[]> {
  await requireRole("admin");
  const out: CustomTemplateSuggestion[] = [];
  for (const [key, val] of Object.entries(SUGGESTED_LAB_OVERRIDES)) {
    const [kind, lab] = key.split("::");
    if (!PATIENT_EMAIL_KINDS.includes(kind as PatientEmailKind)) continue;
    out.push({
      kind: kind as PatientEmailKind,
      triggerLabName: lab,
      subject: val.subject,
      heading: val.heading,
      paragraphs: val.paragraphs,
    });
  }
  return out;
}

const ALL_KINDS = z.enum([
  "sample_sent",
  "partial_uploaded",
  "complete_uploaded",
  "rof_followup",
  "staff_invite",
  "password_reset",
]);

const TemplateUpdate = z.object({
  kind: ALL_KINDS,
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

/**
 * Upsert helper for the global (trigger_lab_name IS NULL) row of a kind.
 * After the migration the table no longer has `kind` as a unique constraint
 * — multiple rows can share a kind (one global + N per-lab) — so we have to
 * find-then-update instead of relying on onConflict:kind.
 */
async function upsertGlobalRow(
  kind: EditableEmailKind,
  patch: {
    subject?: string | null;
    heading?: string | null;
    paragraphs?: string | null;
    bcc?: string | null;
    enabled?: boolean;
  },
  actorId: string,
): Promise<ActionResult> {
  const db = getSupabaseAdmin();
  const { data: existing, error: lookupErr } = await db
    .from("email_templates")
    .select("id")
    .eq("kind", kind)
    .is("trigger_lab_name", null)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };

  if (existing?.id) {
    const { error } = await db
      .from("email_templates")
      .update({ ...patch, updated_by: actorId })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  const { error } = await db
    .from("email_templates")
    .insert({ kind, trigger_lab_name: null, ...patch, updated_by: actorId });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function updateEmailTemplate(input: {
  kind: EditableEmailKind;
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
  const res = await upsertGlobalRow(
    parsed.data.kind,
    {
      subject: parsed.data.subject || null,
      heading: parsed.data.heading,
      paragraphs: parsed.data.paragraphs || null,
      bcc: parsed.data.bcc || null,
    },
    actor.id,
  );
  if (!res.ok) return res;
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function setEmailTemplateEnabled(input: {
  kind: EditableEmailKind;
  enabled: boolean;
}): Promise<ActionResult> {
  const actor = await requireRole("admin");
  const parsed = ALL_KINDS.safeParse(input.kind);
  if (!parsed.success) {
    return { ok: false, error: "Invalid kind" };
  }
  const res = await upsertGlobalRow(
    parsed.data,
    { enabled: input.enabled },
    actor.id,
  );
  if (!res.ok) return res;
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function resetEmailTemplate(input: {
  kind: EditableEmailKind;
}): Promise<ActionResult> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  // Only clears the global row — per-lab overrides for this kind keep
  // their copy. Admin must delete those individually.
  const { error } = await db
    .from("email_templates")
    .delete()
    .eq("kind", input.kind)
    .is("trigger_lab_name", null);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

// ── Custom per-lab email templates ────────────────────────────────────

const PATIENT_KIND = z.enum([
  "sample_sent",
  "partial_uploaded",
  "complete_uploaded",
  "rof_followup",
]);

const CustomCreate = z.object({
  kind: PATIENT_KIND,
  triggerLabName: z.string().trim().min(1).max(200),
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

export async function createCustomEmailTemplate(input: {
  kind: PatientEmailKind;
  triggerLabName: string;
  subject: string;
  heading: string;
  paragraphs: string;
  bcc: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("admin");
  const parsed = CustomCreate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("email_templates")
    .insert({
      kind: parsed.data.kind,
      trigger_lab_name: parsed.data.triggerLabName,
      subject: parsed.data.subject || null,
      heading: parsed.data.heading,
      paragraphs: parsed.data.paragraphs || null,
      bcc: parsed.data.bcc || null,
      updated_by: actor.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    // The unique (kind, trigger_lab_name) index catches duplicates.
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  revalidatePath("/labs/settings");
  return { ok: true, data: { id: data.id } };
}

const CustomUpdate = z.object({
  id: z.string().uuid(),
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

export async function updateCustomEmailTemplate(input: {
  id: string;
  subject: string;
  heading: string;
  paragraphs: string;
  bcc: string;
}): Promise<ActionResult> {
  const actor = await requireRole("admin");
  const parsed = CustomUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("email_templates")
    .update({
      subject: parsed.data.subject || null,
      heading: parsed.data.heading,
      paragraphs: parsed.data.paragraphs || null,
      bcc: parsed.data.bcc || null,
      updated_by: actor.id,
    })
    .eq("id", parsed.data.id)
    .not("trigger_lab_name", "is", null);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

export async function deleteCustomEmailTemplate(input: {
  id: string;
}): Promise<ActionResult> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  // Guard: never delete a global row through this path.
  const { error } = await db
    .from("email_templates")
    .delete()
    .eq("id", input.id)
    .not("trigger_lab_name", "is", null);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs/settings");
  return { ok: true };
}

const TestSendInput = z.object({
  kind: ALL_KINDS,
  toEmail: z.string().trim().email(),
  triggerLabName: z.string().trim().max(200).nullable().optional(),
});

function isStaffKind(kind: EditableEmailKind): kind is StaffEmailKind {
  return kind === "staff_invite" || kind === "password_reset";
}

export async function sendTestEmail(input: {
  kind: EditableEmailKind;
  toEmail: string;
  /** Set when testing a per-lab override card so the preview uses that
   * template (and a sample row whose lab_name matches). */
  triggerLabName?: string | null;
}): Promise<ActionResult<{ messageId?: string }>> {
  await requireRole("admin");
  const parsed = TestSendInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };

  // Staff-template test sends use a real Supabase recovery link so the
  // preview reflects production format (the link won't actually log them
  // in unless they own the email). Patient sends keep the existing
  // sample-data renderer.
  if (isStaffKind(parsed.data.kind)) {
    const db = getSupabaseAdmin();
    const { data: link } = await db.auth.admin.generateLink({
      type: "magiclink",
      email: parsed.data.toEmail,
      options: {
        redirectTo: `${appBaseUrl()}/auth/callback?next=${encodeURIComponent(
          "/auth/set-password?next=/labs",
        )}`,
      },
    });
    const magicLink = link?.properties?.action_link ?? "https://example.com/preview-link";
    const send = await sendStaffEmail({
      kind: parsed.data.kind,
      toEmail: parsed.data.toEmail,
      fullName: null,
      magicLink,
    });
    if (!send.ok) return { ok: false, error: send.error };
    return { ok: true };
  }

  const rendered = await renderTestEmail({
    kind: parsed.data.kind as PatientEmailKind,
    toEmail: parsed.data.toEmail,
    triggerLabName: parsed.data.triggerLabName ?? null,
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
