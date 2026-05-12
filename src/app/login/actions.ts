"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { appBaseUrl } from "@/lib/app-url";
import { sendStaffEmail } from "@/lib/email/staff-sender";

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

  // Look up the user's name (if known) so the password-reset email can
  // greet them properly. Falls back to "there" inside sendStaffEmail.
  const { data: appUser } = await db
    .from("app_users")
    .select("full_name")
    .eq("email", parsed.data.email)
    .maybeSingle();

  const send = await sendStaffEmail({
    kind: "password_reset",
    toEmail: parsed.data.email,
    fullName: (appUser?.full_name as string | null) ?? null,
    magicLink: link.properties.action_link,
  });
  if (!send.ok) {
    return { ok: false, error: send.error };
  }

  return {
    ok: true,
    note: "If we have an account with that email, you'll receive a reset link shortly.",
  };
}
