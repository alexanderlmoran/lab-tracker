// PB login probe — runs a PracticeBetter OAuth login FROM THIS SERVER (Vercel)
// to test whether PB accepts logins from Vercel's IP. PB rejects Fly's
// datacenter IP with error 8000 even with correct creds (works from a
// residential IP), so we need to know if Vercel's IP is a viable exit before
// routing the engine's PB calls through the app instead of the Fly worker.
//
// Auth: Bearer WORKER_SHARED_SECRET. Reads PB_USERNAME / PB_PASSWORD from env.
// Returns the outcome WITHOUT leaking the access token (only status + a short
// error snippet on failure).
//
// Test after deploy:
//   curl -s "https://<your-prod-domain>/api/worker/pb-login-probe" \
//     -H "authorization: Bearer $WORKER_SHARED_SECRET"
//
// Temporary diagnostic — safe to delete once the PB-from-Vercel question is
// answered.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PB_BASE = "https://my.practicebetter.io";
// Must match worker/src/uploaders/practicebetter.ts pbLogin() exactly, or PB
// returns error 9999 (bad client request) regardless of IP.
const PB_CLIENT_ID = "099153c2625149bc8ecb3e85e03f0022";

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const username = process.env.PB_USERNAME;
  const password = process.env.PB_PASSWORD;
  if (!username || !password) {
    return NextResponse.json({
      ok: false,
      reason: "PB_USERNAME / PB_PASSWORD not set on this deployment — add them to the Vercel env to test, or this is why it would fail.",
    });
  }

  const body = new URLSearchParams({
    username,
    password,
    grant_type: "password",
    remember_me: "false",
    verification_code: "",
    client_id: PB_CLIENT_ID,
  });
  const started = Date.now();
  try {
    const res = await fetch(`${PB_BASE}/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });
    const text = await res.text();
    const ok = res.status === 200 && text.includes("access_token");
    return NextResponse.json({
      ok,
      from: "vercel",
      pbStatus: res.status,
      authenticated: ok,
      // Only surface the error shape on failure; never the token on success.
      detail: ok ? "PB accepted this IP — login succeeded" : text.slice(0, 200),
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      from: "vercel",
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    });
  }
}
