import { NextResponse } from "next/server";
import { google } from "googleapis";
import { requireSignedIn } from "@/lib/auth-guard";
import {
  GMAIL_SCOPES,
  getOAuthClient,
  persistTokensFromOAuth,
} from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await requireSignedIn();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL(`/labs/inbox?gmail_error=${encodeURIComponent(error)}`, url.origin),
    );
  }
  if (!code) {
    return NextResponse.redirect(
      new URL("/labs/inbox?gmail_error=missing_code", url.origin),
    );
  }

  const oauth = getOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    return NextResponse.redirect(
      new URL("/labs/inbox?gmail_error=incomplete_tokens", url.origin),
    );
  }

  oauth.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress ?? "unknown";

  await persistTokensFromOAuth({
    email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scopes: GMAIL_SCOPES,
  });

  return NextResponse.redirect(
    new URL(`/labs/inbox?gmail_connected=${encodeURIComponent(email)}`, url.origin),
  );
}
