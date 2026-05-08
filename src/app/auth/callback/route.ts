import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/utils/supabase/server";

// Supabase Auth code-exchange endpoint. Used by magic-link / email-confirmation
// flows. Email+password sign-in does not hit this, but having it in place
// means we can flip on passwordless later without a migration.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/labs";

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  const dest = next.startsWith("/") ? next : "/labs";
  return NextResponse.redirect(new URL(dest, url.origin));
}
