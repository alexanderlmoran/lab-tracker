import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { SetPasswordForm } from "./SetPasswordForm";

type SearchParams = Promise<{ next?: string }>;

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // This page must be reached with a valid Supabase session — either from the
  // /auth/callback code exchange (invite or recovery link), or because the
  // user is already logged in and chose to change their password from the
  // settings page. If neither is true, bounce to /login.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?error=Sign+in+to+set+a+password");
  }
  const { next } = await searchParams;

  return (
    <div className="min-h-dvh bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Set your password
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Signed in as {user.email}. Pick a password you'll use to sign in
            next time.
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <SetPasswordForm next={next} />
        </div>
      </div>
    </div>
  );
}
