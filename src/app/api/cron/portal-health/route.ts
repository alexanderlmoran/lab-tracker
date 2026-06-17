// Daily portal health probe.
//
// Vercel cron hits this once a day. For each portal in SCRAPER_REGISTRY we
// make a lightweight HEAD/GET to the login URL and record whether the
// portal responded. Two consecutive failures flips the row red in
// Settings → Scrapers.
//
// This is a SHALLOW health check — it confirms the portal is reachable, not
// that our cookies still work or that the HAR signature still matches. A
// real "scrape still works" check requires running the actual scraper with
// fresh credentials, which is too expensive for hourly cadence.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Same pattern as
// /api/cron/refresh-tracking.

import { NextResponse } from "next/server";
import { SCRAPER_REGISTRY } from "@/lib/scrapers/registry";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

// Per-probe timeout — portals shouldn't take longer than this to acknowledge.
const PROBE_TIMEOUT_MS = 8000;

type ProbeResult = {
  portalKey: string;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
};

async function probe(portalKey: string, url: string): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      // Pretend to be a normal browser — some portals reject default UA.
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    // Anything 2xx or 3xx counts as "portal is up". 4xx/5xx is suspicious
    // but a 401 on an unauthenticated login page is normal — only treat
    // 5xx as failure. 4xx is "ok" since we got a real response.
    const ok = res.status < 500;
    return {
      portalKey,
      ok,
      statusCode: res.status,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      portalKey,
      ok: false,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Probe in parallel — 11 portals × 8s timeout serial would be 88s. Vercel
  // serverless functions have a default 10-15s limit, so parallel is required.
  const results = await Promise.all(
    SCRAPER_REGISTRY.map((p) => probe(p.key, p.loginUrl)),
  );

  // Read current failure counts AND the real scrapers' last success. The shallow
  // GET above false-reds portals that block datacenter fetches or have TLS/DNS
  // quirks (access refuses, glycanage/spectracell fail TLS, golda won't resolve)
  // even though our actual scraper works fine. The `scrape:<key>` heartbeat is
  // ground truth, so a fresh one OVERRIDES a failed shallow probe — the health
  // view stops lying about portals we're successfully scraping. Portals with no
  // active scraper (e.g. golda) keep the honest shallow result.
  const { data: existingRows } = await db
    .from("lab_scraper_status")
    .select("portal_key, consecutive_failures, last_success_at");
  const existingMap = new Map(
    (existingRows ?? []).map((r) => [
      r.portal_key as string,
      r.consecutive_failures as number,
    ]),
  );
  const SCRAPER_FRESH_MS = 24 * 60 * 60 * 1000;
  const scraperFresh = (key: string): boolean => {
    const row = (existingRows ?? []).find((r) => r.portal_key === `scrape:${key}`);
    const ts = row?.last_success_at ? new Date(row.last_success_at as string).getTime() : 0;
    return ts > 0 && Date.now() - ts < SCRAPER_FRESH_MS;
  };

  // UPSERT per portal — failures increment, successes reset to 0.
  const upserts = results.map((r) => {
    const prev = existingMap.get(r.portalKey) ?? 0;
    const overridden = !r.ok && scraperFresh(r.portalKey);
    const ok = r.ok || overridden;
    return {
      portal_key: r.portalKey,
      last_check_at: now,
      last_success_at: ok ? now : null,
      last_failure_at: ok ? null : now,
      last_status_code: r.statusCode,
      last_error: overridden ? `shallow probe blocked (${r.error}); real scraper OK` : r.error,
      consecutive_failures: ok ? 0 : prev + 1,
    };
  });

  // Two-pass upsert because PostgREST's onConflict update keeps NULL columns
  // we sent. For successes we want to preserve previous last_failure_at; for
  // failures we want to preserve previous last_success_at. Handle each.
  for (const row of upserts) {
    const patch: Record<string, unknown> = {
      portal_key: row.portal_key,
      last_check_at: row.last_check_at,
      last_status_code: row.last_status_code,
      last_error: row.last_error,
      consecutive_failures: row.consecutive_failures,
    };
    if (row.last_success_at) patch.last_success_at = row.last_success_at;
    if (row.last_failure_at) patch.last_failure_at = row.last_failure_at;
    const { error } = await db
      .from("lab_scraper_status")
      .upsert(patch, { onConflict: "portal_key" });
    if (error) {
      console.error(`portal-health upsert ${row.portal_key} failed:`, error.message);
    }
  }

  // Report EFFECTIVE health (after scraper-ground-truth override), not raw probe.
  const failures = upserts.filter((u) => !u.last_success_at).map((u) => ({ portalKey: u.portal_key, error: u.last_error }));
  return NextResponse.json({
    ok: true,
    checkedAt: now,
    probed: results.length,
    healthy: results.length - failures.length,
    failed: failures.length,
    failures,
  });
}
