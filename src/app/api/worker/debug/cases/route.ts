// Read-only diagnostic endpoint for the worker / Claude / Alex when
// debugging case state without round-tripping through Supabase Studio.
//
// Bearer-authed with WORKER_SHARED_SECRET. Always read-only — refuses to
// run anything that mutates. Returns up to 50 rows; intended for "what's
// the current state of <patient>?" queries during demos and audits.
//
// Query params:
//   q=<substring>          patient_name ilike — case-insensitive substring
//   zenoti_id=<uuid>       exact match on zenoti_appointment_id
//   date=YYYY-MM-DD        exact match on collection_date
//   deleted=null|set|any   filter by deleted_at (default: any)
//
// Example:
//   curl -H "authorization: Bearer $WORKER_SHARED_SECRET" \
//     "http://localhost:3000/api/worker/debug/cases?q=brittany&deleted=any"

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  const zenotiId = url.searchParams.get("zenoti_id");
  const date = url.searchParams.get("date");
  const deletedParam = (url.searchParams.get("deleted") ?? "any").toLowerCase();

  const db = getSupabaseAdmin();
  let builder = db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_email, patient_dob, lab_name, zenoti_service_name, collection_date, lab_external_ref, tracking_number, zenoti_appointment_id, zenoti_guest_id, step1_sample_sent, step2_partial_received, step3_partial_uploaded, step4_complete_received, step5_complete_uploaded, step6_rof_scheduled, step7_rof_completed, archived_at, deleted_at, created_at, updated_at, notes",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  if (q) builder = builder.ilike("patient_name", `%${q}%`);
  if (zenotiId) builder = builder.eq("zenoti_appointment_id", zenotiId);
  if (date) builder = builder.eq("collection_date", date);
  if (deletedParam === "null") builder = builder.is("deleted_at", null);
  if (deletedParam === "set") builder = builder.not("deleted_at", "is", null);

  const { data, error } = await builder;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    filters: { q, zenoti_id: zenotiId, date, deleted: deletedParam },
    count: (data ?? []).length,
    cases: data ?? [],
  });
}
