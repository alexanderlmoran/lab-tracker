// Vercel cron entry point. Schedule lives in /vercel.json (top-level).
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` for cron-
// triggered invocations; we reject any other caller. CRON_SECRET must be
// set in Vercel project env vars.

import { NextResponse } from "next/server";
import { refreshTrackingForActiveCasesCore } from "@/lib/tracking/refresh-core";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Accept either the Vercel cron secret OR the worker's shared secret — the
  // Fly worker drives this on a couple-hours cadence (Vercel Hobby caps crons
  // at once/day), authing with the secret it already has. See docs/PLAYBOOK.md.
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.WORKER_SHARED_SECRET;
  if (!cronSecret && !workerSecret) {
    return NextResponse.json(
      { ok: false, error: "no auth secret configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const ok =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (workerSecret && auth === `Bearer ${workerSecret}`);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Allow up to 1000 lookups per cron tick — much higher than the manual
  // button's 300 cap, since cron runtime is not interactive.
  const result = await refreshTrackingForActiveCasesCore({
    actor: "cron",
    limit: 1000,
  });

  // Heartbeat: this loop (worker every ~2h) feeds the "tracking" health signal.
  // CRITICAL — must NOT report success when FedEx itself is failing. In the core,
  // `polled` only increments AFTER a track batch succeeds; if every batch throws
  // (expired/unauthorized FedEx Track creds), we get errors>0 with polled===0 and
  // updated===0 — a TOTAL outage that previously still recorded a green heartbeat,
  // so a 9-day FedEx-403 outage paged no one. Now that case records a FAILURE so
  // the watchdog emails. (polled>0 & updated===0 with no errors is normal — just
  // no status changed — and stays a success.)
  const fedexFailing = !result.ok || (result.errors > 0 && result.polled === 0);
  try {
    const db = getSupabaseAdmin();
    const now = new Date().toISOString();
    if (fedexFailing) {
      const { data: prev } = await db
        .from("lab_scraper_status")
        .select("consecutive_failures")
        .eq("portal_key", "tracking")
        .maybeSingle();
      const fails = (((prev as { consecutive_failures: number } | null)?.consecutive_failures ?? 0) as number) + 1;
      const errMsg = result.ok
        ? `FedEx poll failed for all ${result.errors} eligible case(s) (0 polled) — likely expired/unauthorized FedEx Track API credentials`
        : result.error;
      await db.from("lab_scraper_status").upsert(
        { portal_key: "tracking", last_check_at: now, last_failure_at: now, consecutive_failures: fails, last_error: String(errMsg).slice(0, 300) },
        { onConflict: "portal_key" },
      );
    } else {
      await db.from("lab_scraper_status").upsert(
        { portal_key: "tracking", last_check_at: now, last_success_at: now, consecutive_failures: 0, last_error: null },
        { onConflict: "portal_key" },
      );
    }
  } catch {
    // best-effort heartbeat — never fail the refresh on it
  }

  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    polled: result.polled,
    updated: result.updated,
    errors: result.errors,
    fedexFailing,
    at: new Date().toISOString(),
  });
}
