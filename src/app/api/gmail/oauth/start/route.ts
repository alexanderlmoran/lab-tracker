import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { GMAIL_SCOPES, getOAuthClient } from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireAdmin();
  const oauth = getOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: "offline", // ensure we get a refresh_token
    prompt: "consent", // force-issue a refresh_token even on re-auth
    scope: GMAIL_SCOPES,
  });
  return NextResponse.redirect(url);
}
