// Diagnostic + admin endpoint for the worker / Claude / Alex when working
// with case state without round-tripping through Supabase Studio.
//
// Bearer-authed with WORKER_SHARED_SECRET. The GET handler is read-only
// (default 50 rows for "what's the current state of <patient>?" queries;
// pass limit=all for the org-wide backfill scripts, which paginates the
// whole table). The PATCH handler is the admin escape hatch and DOES
// mutate — see its docstring for the supported actions.
//
// Query params:
//   q=<substring>          patient_name ilike — case-insensitive substring
//   zenoti_id=<uuid>       exact match on zenoti_appointment_id
//   date=YYYY-MM-DD        exact match on collection_date
//   deleted=null|set|any   filter by deleted_at (default: any)
//   limit=<n>|all          row cap (default 50, max 5000); "all" pages fully
//
// Example:
//   curl -H "authorization: Bearer $WORKER_SHARED_SECRET" \
//     "http://localhost:3000/api/worker/debug/cases?q=brittany&deleted=any"

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/worker/debug/cases?id=<uuid>&action=<action>
 *
 * Manual admin escape hatch — used when a case is stuck in a loop, has bad
 * data, or just needs to be force-killed without going through the normal
 * UI. Bearer-authed with WORKER_SHARED_SECRET. Supported actions:
 *   - archive            sets archived_at; immune to the sync's
 *                        restore-on-resync (which only un-deletes deleted_at,
 *                        never un-archives) — right when Zenoti keeps
 *                        reporting an appointment we don't want to track.
 *   - soft-delete        sets deleted_at.
 *   - hard-delete        removes the row entirely.
 *   - set-collection-date  write-once backfill of collection_date (Backfill
 *                        Brain; refuses if already set).
 *   - advance-step5      silent step5 advance, bypasses the email cascade
 *                        (Backfill Brain).
 */
export async function PATCH(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const action = url.searchParams.get("action");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: "id (uuid) required" }, { status: 400 });
  }
  if (
    action !== "archive" &&
    action !== "soft-delete" &&
    action !== "hard-delete" &&
    action !== "set-collection-date" &&
    action !== "advance-step5"
  ) {
    return NextResponse.json(
      { ok: false, error: "action must be archive | soft-delete | hard-delete | set-collection-date | advance-step5" },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();

  if (action === "hard-delete") {
    const { error } = await db.from("lab_cases").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id, action: "hard-delete" });
  }

  // Write-once backfill of collection_date. Only succeeds if the column is
  // currently NULL — protects us from clobbering a real date entered by
  // staff. The CSV-backfill script is the only caller today.
  if (action === "set-collection-date") {
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { ok: false, error: "date=YYYY-MM-DD required" },
        { status: 400 },
      );
    }
    const { data, error } = await db
      .from("lab_cases")
      .update({ collection_date: date })
      .eq("id", id)
      .is("collection_date", null)
      .select("id, collection_date");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data || data.length === 0) {
      return NextResponse.json(
        { ok: false, error: "case not found or collection_date already set" },
        { status: 409 },
      );
    }
    // Audit the backfill. `case_edited` is the closest existing
    // lab_event_kind — there's no dedicated "backfilled" value in the enum,
    // and adding one would need a DB migration; the note carries specifics.
    // Best-effort: the collection_date write above is the source of truth,
    // so a failed event log is warned, not fatal (and not silently swallowed).
    const { error: evErr } = await db.from("lab_events").insert({
      case_id: id,
      kind: "case_edited",
      actor: "admin:debug-endpoint",
      note: `collection_date backfilled to ${date} via CSV join`,
    });
    if (evErr) {
      console.warn(`[debug/cases] set-collection-date audit log failed for ${id}: ${evErr.message}`);
    }
    return NextResponse.json({ ok: true, id, action, collection_date: date });
  }

  // Backfill brain: silent step5 advance. Sets step5_complete_uploaded=true
  // without firing the normal email cascade (Nadia "all labs complete" /
  // Allison handoff). Used by the historical backfill flow where the lab
  // result is already on PB — staff don't need a fresh notification.
  // Idempotent: re-running on an already-advanced row succeeds silently.
  if (action === "advance-step5") {
    const { data, error } = await db
      .from("lab_cases")
      .update({ step5_complete_uploaded: true })
      .eq("id", id)
      .select("id, step5_complete_uploaded");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data || data.length === 0) {
      return NextResponse.json({ ok: false, error: "case not found" }, { status: 404 });
    }
    const { error: evErr } = await db.from("lab_events").insert({
      case_id: id,
      kind: "step_toggled",
      step: 5,
      completed: true,
      actor: "admin:backfill-brain",
      note: "Backfill brain silent advance — lab already on PB, no email fired",
    });
    if (evErr) {
      console.warn(`[debug/cases] advance-step5 audit log failed for ${id}: ${evErr.message}`);
    }
    return NextResponse.json({ ok: true, id, action });
  }

  const patch: Record<string, unknown> =
    action === "archive"
      ? { archived_at: new Date().toISOString() }
      : { deleted_at: new Date().toISOString() };
  const { error } = await db.from("lab_cases").update(patch).eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Emit an audit event so the activity log shows what happened.
  await db.from("lab_events").insert({
    case_id: id,
    kind: action === "archive" ? "case_archived" : "case_deleted",
    actor: "admin:debug-endpoint",
    note: `Force-${action} via /api/worker/debug/cases PATCH`,
  });

  return NextResponse.json({ ok: true, id, action });
}

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
  // limit=all paginates the whole result set (for org-wide backfill scripts);
  // otherwise a numeric cap (default 50, clamped) for quick state checks.
  // PostgREST caps a single response at ~1000 rows, so "all" must page.
  const limitParam = url.searchParams.get("limit");
  const fetchAll = limitParam === "all";
  const numericLimit = (() => {
    const n = Number.parseInt(limitParam ?? "", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 50;
  })();

  const SELECT =
    "id, patient_name, patient_email, patient_dob, lab_name, zenoti_service_name, collection_date, lab_external_ref, tracking_number, zenoti_appointment_id, zenoti_guest_id, step1_sample_sent, step2_partial_received, step3_partial_uploaded, step4_complete_received, step5_complete_uploaded, step6_rof_scheduled, step7_rof_completed, archived_at, deleted_at, created_at, updated_at, notes";

  const db = getSupabaseAdmin();

  // Builds a fresh filtered query; the caller appends the terminal
  // .range()/.limit(). Reassignment mirrors the chain pattern used elsewhere.
  function filtered() {
    let b = db
      .from("lab_cases")
      .select(SELECT)
      .order("created_at", { ascending: false });
    if (q) b = b.ilike("patient_name", `%${q}%`);
    if (zenotiId) b = b.eq("zenoti_appointment_id", zenotiId);
    if (date) b = b.eq("collection_date", date);
    if (deletedParam === "null") b = b.is("deleted_at", null);
    if (deletedParam === "set") b = b.not("deleted_at", "is", null);
    return b;
  }

  const cases: unknown[] = [];
  if (fetchAll) {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await filtered().range(offset, offset + PAGE - 1);
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      cases.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
  } else {
    const { data, error } = await filtered().limit(numericLimit);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    cases.push(...(data ?? []));
  }

  return NextResponse.json({
    ok: true,
    filters: { q, zenoti_id: zenotiId, date, deleted: deletedParam, limit: fetchAll ? "all" : numericLimit },
    count: cases.length,
    cases,
  });
}
