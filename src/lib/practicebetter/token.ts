import "server-only";

const TOKEN_URL = "https://api.practicebetter.io/oauth2/token";
const SAFETY_MARGIN_MS = 60_000;

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

function readCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PRACTICEBETTER_CLIENT_ID;
  const clientSecret = process.env.PRACTICEBETTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "PracticeBetter env vars missing (PRACTICEBETTER_CLIENT_ID / PRACTICEBETTER_CLIENT_SECRET).",
    );
  }
  return { clientId, clientSecret };
}

async function mintToken(): Promise<CachedToken> {
  const { clientId, clientSecret } = readCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PB token mint failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("PB token response missing access_token/expires_in");
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** Returns a valid bearer token, refreshing if expired/near-expiry. Coalesces concurrent refreshes. */
export async function getPracticeBetterAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }
  if (!inflight) {
    inflight = mintToken().finally(() => {
      inflight = null;
    });
  }
  cached = await inflight;
  return cached.accessToken;
}

/** Force-discard the cache — useful after a 401 to retry once with a fresh token. */
export function invalidatePracticeBetterToken(): void {
  cached = null;
}

/** Telemetry helper for the health panel. */
export function getPracticeBetterTokenStatus(): {
  cached: boolean;
  expiresAt: number | null;
  expiresInSeconds: number | null;
} {
  if (!cached) return { cached: false, expiresAt: null, expiresInSeconds: null };
  return {
    cached: true,
    expiresAt: cached.expiresAt,
    expiresInSeconds: Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000)),
  };
}
