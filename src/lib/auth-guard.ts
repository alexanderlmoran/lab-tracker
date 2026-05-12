import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export type AppRole = "developer" | "admin" | "staff";

const ROLE_RANK: Record<AppRole, number> = {
  staff: 1,
  admin: 2,
  developer: 3,
};

export type SessionUser = {
  id: string;
  email: string;
  role: AppRole;
  fullName: string | null;
};

/** Anyone authenticated. Redirects to /login if not. Auto-provisions an
 * app_users row with `staff` role for first-login users so the table doesn't
 * drift out of sync with auth.users (e.g. when a developer logs in fresh). */
export async function requireUser(): Promise<SessionUser> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) redirect("/login");
  const u = user!;

  const db = getSupabaseAdmin();
  const { data: existing } = await db
    .from("app_users")
    .select("user_id, email, role, full_name")
    .eq("user_id", u.id)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.user_id,
      email: existing.email,
      role: existing.role as AppRole,
      fullName: existing.full_name ?? null,
    };
  }

  // First-time login: insert with default role.
  // BOOTSTRAP: if no app_users rows exist yet, the first authenticated user
  // is promoted to developer. This is the only path that creates a developer
  // without a developer already existing.
  const { count } = await db
    .from("app_users")
    .select("user_id", { count: "exact", head: true });
  const isBootstrap = (count ?? 0) === 0;
  const role: AppRole = isBootstrap ? "developer" : "staff";

  await db.from("app_users").insert({
    user_id: u.id,
    email: u.email,
    role,
  });

  return {
    id: u.id,
    email: u.email!,
    role,
    fullName: null,
  };
}

/** Require the user to hold `minRole` or higher. Redirects to /labs if
 * authenticated but under-privileged, or /login if not authenticated. */
export async function requireRole(minRole: AppRole): Promise<SessionUser> {
  const user = await requireUser();
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    redirect("/labs?forbidden=1");
  }
  return user;
}

/** Any authenticated user — does NOT gate by role. Use this on paths every
 * signed-in staff member should reach (kanban, inbox, case detail). For
 * admin-only routes call `requireRole("admin")` instead.
 *
 * Replaces the old `requireAdmin` name, which lied about what it did. The
 * deprecated alias below remains so old call sites keep compiling — the
 * eslint-disable hint is intentional: we want the lint warning everywhere
 * `requireAdmin` is still imported so future cleanup is mechanical. */
export async function requireSignedIn(): Promise<SessionUser> {
  return requireUser();
}

/** @deprecated Use `requireSignedIn` (any signed-in user) or
 *  `requireRole("admin")` (true admin gate). Kept for back-compat. */
export async function requireAdmin(): Promise<SessionUser> {
  return requireUser();
}

export function hasRole(user: SessionUser, minRole: AppRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minRole];
}
