"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/utils/supabase/server";

const Input = z.object({
  password: z
    .string()
    .min(10, "Use at least 10 characters.")
    .max(200, "Too long.")
    .regex(/[a-z]/, "Include at least one lowercase letter.")
    .regex(/[A-Z]/, "Include at least one uppercase letter.")
    .regex(/[0-9]/, "Include at least one digit."),
  confirm: z.string(),
  next: z.string().optional(),
});

export type SetPasswordResult = { ok: true } | { ok: false; error: string };

export async function setPasswordAction(
  formData: FormData,
): Promise<SetPasswordResult> {
  const parsed = Input.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.password !== parsed.data.confirm) {
    return { ok: false, error: "Passwords don't match." };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Session expired — open the email link again." };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) return { ok: false, error: error.message };

  const dest =
    parsed.data.next && parsed.data.next.startsWith("/")
      ? parsed.data.next
      : "/labs";
  redirect(dest);
}
