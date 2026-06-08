import { NextResponse, type NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/utils/supabase/session";

// /api/cron/* runs on a schedule (Supabase pg_cron or Vercel cron) and
// authenticates via Authorization: Bearer ${CRON_SECRET} in each route
// handler — it has no Supabase session, so it must skip this middleware.
// /api/worker/* is called by the off-tracker worker process and authenticates
// via Bearer ${WORKER_SHARED_SECRET} in each route handler — same story.
// /api/nadia/* is hit unauthenticated from Nadia's email link.
const PUBLIC_PREFIXES = [
  "/login",
  "/auth/",
  "/api/cron/",
  "/api/worker/",
  "/api/nadia/",
];

export async function proxy(request: NextRequest) {
  const { response, user } = await refreshSupabaseSession(request);

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/labs";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|pdf\\.worker\\.min\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
