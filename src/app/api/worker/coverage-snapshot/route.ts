// Worker ships the PB labrequest roster (it has PB egress); the tracker owns the
// case data, so it does the join + classify here and writes a lab_audit_runs
// snapshot. Powers the Analytics "Engine" tab live PB-coverage %.
// Contract: worker/src/tracker-client.ts → postCoverageSnapshot.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { computeCoverage, type CoverageCase } from "@/lib/labs/pb-coverage";

export const dynamic = "force-dynamic";

const Body = z.object({
  labrequests: z
    .array(
      z.object({
        name: z.string(),
        dateOrdered: z.string().nullable().optional(),
        clientId: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
      }),
    )
    .max(10000),
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
  const labrequests = parsed.data.labrequests.map((l) => ({
    name: l.name,
    dateOrdered: l.dateOrdered ?? null,
    clientId: l.clientId ?? null,
    firstName: l.firstName ?? null,
    lastName: l.lastName ?? null,
  }));

  const db = getSupabaseAdmin();

  // Every complete case (the "Completed" lane is archived, so include archived).
  const { data: caseRows, error: caseErr } = await db
    .from("lab_cases")
    .select("patient_name, patient_dob, lab_name, lab_external_ref, collection_date")
    .eq("step5_complete_uploaded", true)
    .is("deleted_at", null)
    .limit(5000);
  if (caseErr) {
    return NextResponse.json({ ok: false, error: caseErr.message }, { status: 500 });
  }
  const cases = (caseRows ?? []) as CoverageCase[];

  const snap = computeCoverage(cases, labrequests);
  const { error } = await db.from("lab_audit_runs").insert({
    total: snap.total,
    strong: snap.strong,
    likely: snap.likely,
    missing: snap.missing,
    no_match: snap.no_match,
    coverage_pct: snap.coverage_pct,
    gaps: snap.gaps,
  });
  if (error) {
    console.warn(`[coverage-snapshot] insert failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }
  return NextResponse.json({ ok: true, snapshot: { total: snap.total, coverage_pct: snap.coverage_pct } });
}
