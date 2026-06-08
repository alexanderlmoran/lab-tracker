// Worker reports a finished reconcile cycle → one lab_engine_runs row.
// Lets the Analytics "Engine" tab chart auto-posted / flagged / errors over time.
// Contract: worker/src/tracker-client.ts → postEngineRun.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  lab: z.string().optional(),
  mode: z.enum(["apply", "dry"]).default("apply"),
  advanced: z.number().int().nonnegative().default(0),
  autoposted: z.number().int().nonnegative().default(0),
  flagged: z.number().int().nonnegative().default(0),
  searching: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative().default(0),
  details: z.unknown().optional(),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "bad body" }, { status: 400 });
  }
  const { details, ...row } = parsed.data;

  const db = getSupabaseAdmin();
  const { error } = await db.from("lab_engine_runs").insert({ ...row, details: details ?? null });
  if (error) {
    // Don't fail the worker's cycle over a metrics write — log + 200 with a flag.
    console.warn(`[engine-run] insert failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}
