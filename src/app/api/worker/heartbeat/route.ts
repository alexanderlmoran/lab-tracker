// Generic worker heartbeat sink. Any always-on loop (scrape, tracking, ivpost,
// reconcile, pbdrain, …) POSTs here every cycle so we have ONE truthful record
// of "is this loop alive" — the thing we were missing when the automation died
// silently for 8 days. Reuses lab_scraper_status (same table the Zenoti sync
// already heartbeats to via /api/worker/cases); the watchdog cron
// (/api/cron/heartbeat-watch) reads it and emails when a key goes stale.
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.
//   body: { key: string, status: "ok" | "error", error?: string, statusCode?: number }

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let body: { key?: string; status?: string; error?: string; statusCode?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
  const key = (body.key ?? "").trim();
  if (!key) return NextResponse.json({ ok: false, error: "key required" }, { status: 400 });
  const ok = body.status !== "error";
  const now = new Date().toISOString();
  const db = getSupabaseAdmin();

  if (ok) {
    // Success → fresh last_success_at, reset the failure streak.
    await db.from("lab_scraper_status").upsert(
      { portal_key: key, last_check_at: now, last_success_at: now, consecutive_failures: 0, last_error: null, last_status_code: body.statusCode ?? null },
      { onConflict: "portal_key" },
    );
  } else {
    // Failure → bump the streak (read-modify-write; one writer per key, so no
    // real contention), keep the prior last_success_at so staleness is measured
    // from the last GOOD run.
    const { data: prev } = await db.from("lab_scraper_status").select("consecutive_failures").eq("portal_key", key).maybeSingle();
    const failures = ((prev?.consecutive_failures as number | null) ?? 0) + 1;
    await db.from("lab_scraper_status").upsert(
      { portal_key: key, last_check_at: now, last_failure_at: now, consecutive_failures: failures, last_error: (body.error ?? "").slice(0, 500), last_status_code: body.statusCode ?? null },
      { onConflict: "portal_key" },
    );
  }
  return NextResponse.json({ ok: true });
}
