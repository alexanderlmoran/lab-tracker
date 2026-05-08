import "server-only";
import { google, type Auth } from "googleapis";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

export function getOAuthClient(): Auth.OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT;
  if (!clientId || !clientSecret || !redirect) {
    throw new Error(
      "Google OAuth env vars missing (GOOGLE_CLIENT_ID/SECRET/REDIRECT).",
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirect);
}

export type StoredGmailTokens = {
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  last_synced_at: string | null;
  last_history_id: string | null;
};

export async function loadStoredTokens(): Promise<StoredGmailTokens | null> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("gmail_oauth_tokens")
    .select("*")
    .eq("id", "primary")
    .maybeSingle();
  return (data as StoredGmailTokens | null) ?? null;
}

/** Build an authorized OAuth client, refreshing the access token if expired. */
export async function getAuthorizedGmailClient(): Promise<{
  auth: Auth.OAuth2Client;
  email: string;
} | null> {
  const stored = await loadStoredTokens();
  if (!stored) return null;
  const oauth = getOAuthClient();
  oauth.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: new Date(stored.expires_at).getTime(),
    scope: stored.scopes.join(" "),
  });

  const expired = Date.now() > new Date(stored.expires_at).getTime() - 60_000;
  if (expired) {
    const { credentials } = await oauth.refreshAccessToken();
    if (credentials.access_token) {
      const db = getSupabaseAdmin();
      await db
        .from("gmail_oauth_tokens")
        .update({
          access_token: credentials.access_token,
          expires_at: new Date(
            credentials.expiry_date ?? Date.now() + 3600_000,
          ).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", "primary");
      oauth.setCredentials(credentials);
    }
  }

  return { auth: oauth, email: stored.email };
}

export async function persistTokensFromOAuth(args: {
  email: string;
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scopes: string[];
}) {
  const db = getSupabaseAdmin();
  const expires_at = new Date(args.expiry_date).toISOString();
  await db.from("gmail_oauth_tokens").upsert({
    id: "primary",
    email: args.email,
    access_token: args.access_token,
    refresh_token: args.refresh_token,
    expires_at,
    scopes: args.scopes,
    updated_at: new Date().toISOString(),
  });
}
