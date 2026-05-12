"use server";

import { z } from "zod";
import { createSupabaseServerClient } from "@/utils/supabase/server";

const Input = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z
    .string()
    .min(10, "Use at least 10 characters.")
    .max(200, "Too long.")
    .regex(/[a-z]/, "Include at least one lowercase letter.")
    .regex(/[A-Z]/, "Include at least one uppercase letter.")
    .regex(/[0-9]/, "Include at least one digit."),
  confirm: z.string(),
});

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; error: string };

/** Self-service password change for the currently signed-in user. We
 * re-authenticate with the supplied current password first — Supabase's
 * updateUser({ password }) doesn't require this on its own, but doing it
 * ourselves prevents a stolen session from silently rotating the password.
 *
 * On success the session keeps its existing access token. The user stays
 * signed in. Other devices logged in as the same user are NOT signed out;
 * if that becomes a requirement we can pair this with an
 * `auth.admin.signOut(userId, { scope: 'others' })` call. */
export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<ChangePasswordResult> {
  const parsed = Input.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.newPassword !== parsed.data.confirm) {
    return { ok: false, error: "New passwords don't match." };
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return {
      ok: false,
      error: "Pick a new password that's different from your current one.",
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { ok: false, error: "You're not signed in." };
  }

  // Re-auth check. signInWithPassword issues a fresh session if successful,
  // which Supabase merges into the same auth cookies — the user's session
  // stays continuous from their perspective.
  const reauth = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (reauth.error) {
    return { ok: false, error: "Current password is wrong." };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
