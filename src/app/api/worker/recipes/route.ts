// Recipe engine, Phase 3: serve DB recipe overrides to the worker.
//
// The worker (worker/src/recipes/load.ts) GETs this, merges the rows over its
// built-in catalog (DB wins by key), and falls back to catalog-only on any error.
// Auth: Bearer ${WORKER_SHARED_SECRET}, same as the other /api/worker/* routes.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

type RecipeRow = {
  key: string;
  lab_name: string;
  transport: string;
  auth: unknown;
  discovery: unknown;
  pdf: unknown;
  match_cfg: unknown;
  ready_cfg: unknown;
};

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "WORKER_SHARED_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("scraper_recipes")
    .select("key, lab_name, transport, auth, discovery, pdf, match_cfg, ready_cfg")
    .eq("enabled", true);

  if (error) {
    // Table may not exist yet (migration unapplied) — return empty so the worker
    // cleanly falls back to its built-in catalog rather than erroring.
    return NextResponse.json({ ok: true, recipes: [], note: error.message });
  }

  // Shape rows into the worker's LabRecipe contract.
  const recipes = ((data ?? []) as RecipeRow[]).map((r) => ({
    key: r.key,
    labName: r.lab_name,
    transport: r.transport,
    auth: r.auth,
    discovery: r.discovery,
    pdf: r.pdf,
    match: r.match_cfg ?? undefined,
    ready: r.ready_cfg ?? undefined,
  }));

  return NextResponse.json({ ok: true, recipes });
}
