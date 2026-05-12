"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { Resend } from "resend";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { appBaseUrl } from "@/lib/app-url";
import { loadEmailConfig } from "@/lib/email/render";

const Input = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function loginAction(formData: FormData): Promise<LoginResult> {
  const parsed = Input.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: "Enter a valid email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const dest =
    parsed.data.next && parsed.data.next.startsWith("/")
      ? parsed.data.next
      : "/labs";
  redirect(dest);
}

export async function logoutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const ForgotInput = z.object({
  email: z.string().trim().email(),
});

export type ForgotPasswordResult =
  | { ok: true; note: string }
  | { ok: false; error: string };

/** Send a "reset your password" email to the supplied address. We use the
 * Supabase admin client to generate a recovery link, then send the email
 * ourselves via Resend (same path as invites) so it comes from our domain.
 *
 * The response message is intentionally generic — we don't reveal whether
 * the email is in the system, to avoid leaking account enumeration. The
 * only signal that comes back to the form is "sent" vs. "Resend failed". */
export async function forgotPasswordAction(
  formData: FormData,
): Promise<ForgotPasswordResult> {
  const parsed = ForgotInput.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { ok: false, error: "Enter a valid email." };
  }

  const db = getSupabaseAdmin();
  const redirectTo = `${appBaseUrl()}/auth/callback?next=${encodeURIComponent("/auth/set-password?next=/labs")}`;

  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: "recovery",
    email: parsed.data.email,
    options: { redirectTo },
  });

  // Don't surface "user not found" — generic success either way so we don't
  // leak whether the email belongs to a real account.
  if (linkErr || !link?.properties?.action_link) {
    return {
      ok: true,
      note: "If we have an account with that email, you'll receive a reset link shortly.",
    };
  }

  const actionLink = link.properties.action_link;
  const ctx = await loadEmailConfig();
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Last-ditch in dev: surface the link so the developer can copy it.
    return {
      ok: false,
      error: `RESEND_API_KEY not set. Reset link: ${actionLink}`,
    };
  }

  const practice = ctx.practiceName || "Lab Tracker";
  const html = `
    <p>Hi,</p>
    <p>We received a request to reset your ${escapeHtml(practice)} password. Click the link below to choose a new one:</p>
    <p><a href="${actionLink}">${actionLink}</a></p>
    <p style="color:#6b7a8c;font-size:12px;">If you didn't request this, you can ignore this email — your current password stays active.</p>
  `;
  const text = `We received a request to reset your ${practice} password.\n\nReset: ${actionLink}\n\nIf you didn't request this, ignore this email.`;

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from: ctx.fromHeader,
      to: [ctx.testRedirect ?? parsed.data.email],
      replyTo: ctx.replyTo,
      subject: ctx.testRedirect
        ? `[TEST → ${parsed.data.email}] Reset your ${practice} password`
        : `Reset your ${practice} password`,
      html,
      text,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not send reset email",
    };
  }

  return {
    ok: true,
    note: "If we have an account with that email, you'll receive a reset link shortly.",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
