import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/utils/supabase/server";

/**
 * Supabase Auth code-exchange endpoint. Handles links from:
 *   • generateLink({type: "magiclink"|"recovery"|"invite"})   →  ?code=…
 *   • Older Supabase email links (some templates)             →  ?token_hash=…&type=…
 *
 * On any exchange failure we redirect to /login with a concrete error so the
 * user knows what to do next (request a fresh link). Previously this route
 * silently swallowed failures and the user was bounced to a generic /login
 * with no explanation — which is exactly the "link worked but did nothing"
 * symptom Nadia hit.
 */
function loginUrlWithError(origin: string, error: string): URL {
  const u = new URL("/login", origin);
  u.searchParams.set("error", error);
  return u;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const supabaseError = url.searchParams.get("error_description") ||
    url.searchParams.get("error");
  const next = url.searchParams.get("next") ?? "/labs";

  // Supabase itself can redirect here with ?error=... (expired token, etc.).
  // Surface that directly instead of silently continuing.
  if (supabaseError) {
    return NextResponse.redirect(
      loginUrlWithError(
        url.origin,
        `Sign-in link error: ${supabaseError}. Request a new link with Forgot password.`,
      ),
    );
  }

  const supabase = await createSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        loginUrlWithError(
          url.origin,
          `Sign-in link couldn't be verified (${error.message}). It may have expired or already been used — request a fresh one with Forgot password.`,
        ),
      );
    }
  } else if (tokenHash && type) {
    // Legacy email-template style. verifyOtp accepts the same set of types
    // generateLink produces (magiclink, invite, recovery, signup, email).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase.auth.verifyOtp({
      // Supabase's TS type for `type` is a strict union — runtime accepts the
      // literals we pass. Cast keeps us flexible for new template kinds.
      type: type as "magiclink" | "recovery" | "invite" | "signup" | "email",
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(
        loginUrlWithError(
          url.origin,
          `Sign-in link couldn't be verified (${error.message}). It may have expired or already been used — request a fresh one with Forgot password.`,
        ),
      );
    }
  } else {
    // No exchangeable credential present. This means either (a) the user
    // arrived here directly, or (b) the email client prefetched the link
    // and consumed the token before the user clicked.
    return NextResponse.redirect(
      loginUrlWithError(
        url.origin,
        "This sign-in link is missing its verification token. Some email apps preview links and use them up — request a fresh one with Forgot password and click it within a minute.",
      ),
    );
  }

  const dest = next.startsWith("/") ? next : "/labs";
  return NextResponse.redirect(new URL(dest, url.origin));
}
