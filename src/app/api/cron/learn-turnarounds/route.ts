// Daily turnaround auto-learn cron.
//
// Recomputes every lab's labs_catalog.turnaround_days_min/max (p25/p75) from
// observed collection_date → step-4 (results received) history. This is the
// scheduled, no-click version of the "Recompute now" button in Analytics →
// Reports; both call the same recomputeTurnaroundsCore. The learned turnaround
// drives the auto-pull result window (open-cases effectiveWindow → when
// scrapers fetch), so refreshing it daily as more history lands keeps that
// window tight without a human remembering to press the button.
//
// Auth mirrors /api/cron/stale-digest and /api/cron/portal-health: Vercel sends
// `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.

import { NextResponse } from "next/server";
import { recomputeTurnaroundsCore } from "@/lib/labs/learn-turnarounds-core";
import { invalidateEffectiveCatalogCache } from "@/lib/labs/effective";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const result = await recomputeTurnaroundsCore();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }

  // Clear this instance's effective-catalog memo so any subsequent request on
  // the same warm serverless instance reads the freshly-learned turnarounds.
  invalidateEffectiveCatalogCache();

  return NextResponse.json({
    ok: true,
    updated: result.data?.updatedLabs.length ?? 0,
    insufficient: result.data?.insufficientObservations.length ?? 0,
    unmapped: result.data?.unmappedLabs.length ?? 0,
    updatedLabs: result.data?.updatedLabs ?? [],
    at: new Date().toISOString(),
  });
}
