"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import {
  FedExError,
  fedexTrackBatch,
  isFedExConfigured,
  type FedExTrackResult,
} from "@/lib/tracking/fedex";
import {
  isPickupConfigured,
  schedulePickup,
  type SchedulePickupInput,
} from "@/lib/tracking/fedex-pickup";
import type { ActionResult, TrackingStatus } from "@/lib/types";

/** Book a FedEx carrier pickup from the clinic (reuses the tracking OAuth).
 * When `caseIds` are given, stamps the pickup confirmation onto those cards so
 * each is traceable to the day's pickup. Returns the confirmation number;
 * degrades to a clear "not configured" error when the product/account isn't set. */
export async function scheduleFedexPickup(
  input: SchedulePickupInput & { caseIds?: string[] },
): Promise<ActionResult<{ confirmationNumber: string; location?: string; stamped: number }>> {
  const user = await requireSignedIn();
  if (!isPickupConfigured()) {
    return {
      ok: false,
      error:
        "FedEx pickup isn't configured yet — set FEDEX_ACCOUNT_NUMBER + the FEDEX_PICKUP_* address env vars, and enable the Pickup product on the FedEx Developer project.",
    };
  }
  const { caseIds, ...pickupInput } = input;

  // Idempotency guard — the FedEx call dispatches (and bills) a real truck.
  // Drop cards already stamped with a pickup for this ready-date, and when
  // EVERY selected card is covered, return the existing confirmation without
  // calling FedEx at all (double-click / retry safe).
  let targetIds = caseIds ?? [];
  if (targetIds.length > 0) {
    const db = getSupabaseAdmin();
    const { data: existing } = await db
      .from("lab_cases")
      .select("id, pickup_confirmation, pickup_scheduled_date")
      .in("id", targetIds);
    const already = (existing ?? []).filter(
      (r) => r.pickup_confirmation && r.pickup_scheduled_date === pickupInput.readyDate,
    );
    if (already.length > 0 && already.length === targetIds.length) {
      return {
        ok: true,
        data: {
          confirmationNumber: already[0].pickup_confirmation as string,
          stamped: 0,
        },
      };
    }
    const alreadyIds = new Set(already.map((r) => r.id as string));
    targetIds = targetIds.filter((id) => !alreadyIds.has(id));
  }

  try {
    const r = await schedulePickup(pickupInput);
    let stamped = 0;
    if (targetIds.length > 0) {
      const db = getSupabaseAdmin();
      const { data } = await db
        .from("lab_cases")
        .update({
          pickup_confirmation: r.confirmationNumber,
          pickup_scheduled_date: pickupInput.readyDate,
          pickup_carrier: "fedex",
        })
        .in("id", targetIds)
        .select("id");
      stamped = (data ?? []).length;
      await db.from("lab_events").insert(
        targetIds.map((id) => ({
          case_id: id,
          kind: "case_edited" as const,
          actor: user.email ?? "staff",
          note: `FedEx pickup scheduled — confirmation ${r.confirmationNumber} (ready ${pickupInput.readyDate})`,
        })),
      );
      revalidatePath("/labs");
    }
    return {
      ok: true,
      data: { confirmationNumber: r.confirmationNumber, location: r.location, stamped },
    };
  } catch (err) {
    const msg = err instanceof FedExError ? err.message : err instanceof Error ? err.message : "Pickup failed";
    return { ok: false, error: msg };
  }
}

type CaseRow = {
  id: string;
  tracking_number: string | null;
  tracking_status: TrackingStatus | null;
};

function mergeUpdate(result: FedExTrackResult, existing: CaseRow) {
  // Don't overwrite an existing `delivered` with a later `unknown` — FedEx
  // sometimes returns "no information available" after a package has long
  // since been delivered. Keep the most-recent useful state.
  if (result.status === "unknown" && existing.tracking_status === "delivered") {
    return null;
  }
  const polledIso = new Date().toISOString();
  return {
    tracking_carrier: "fedex" as const,
    tracking_status: result.status,
    tracking_status_detail: result.statusDetail,
    tracking_event_at: result.eventAtIso,
    tracking_location: result.location,
    tracking_polled_at: polledIso,
    tracking_delivered_at: result.deliveredAtIso ?? null,
  };
}

/**
 * Refresh a single case's FedEx tracking. Used by the "Refresh tracking"
 * button on case detail. Returns the updated tracking snapshot or an error.
 */
export async function refreshTrackingForCase(
  caseId: string,
): Promise<ActionResult<{
  status: TrackingStatus;
  detail: string | null;
  location: string | null;
  eventAtIso: string | null;
  deliveredAtIso: string | null;
}>> {
  const user = await requireSignedIn();
  if (!isFedExConfigured()) {
    return {
      ok: false,
      error: "FedEx not configured — set FEDEX_API_KEY/SECRET/BASE in env",
    };
  }
  const db = getSupabaseAdmin();
  const { data: row, error: fetchErr } = await db
    .from("lab_cases")
    .select("id, tracking_number, tracking_status, step1_sample_sent")
    .eq("id", caseId)
    .maybeSingle();
  if (fetchErr || !row) {
    return { ok: false, error: fetchErr?.message ?? "Case not found" };
  }
  if (!row.tracking_number) {
    return { ok: false, error: "No tracking number on this case" };
  }

  let results: FedExTrackResult[];
  try {
    results = await fedexTrackBatch([row.tracking_number]);
  } catch (err) {
    const e = err instanceof FedExError ? err : new Error(String(err));
    return { ok: false, error: `FedEx error: ${e.message}` };
  }
  const r = results[0];
  if (!r) return { ok: false, error: "No result returned from FedEx" };

  const update = mergeUpdate(r, row as CaseRow);
  if (update) {
    const { error: updateErr } = await db
      .from("lab_cases")
      .update(update)
      .eq("id", caseId);
    if (updateErr) return { ok: false, error: updateErr.message };
  }

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "tracking_refreshed",
    actor: user.email ?? "admin",
    note: `${r.status}${r.location ? ` · ${r.location}` : ""}${r.statusDetail ? ` — ${r.statusDetail}` : ""}`,
  });

  // First-time delivered transition: ensure step 1 is ticked. Mirrors the
  // logic in refresh-core.ts so both manual and cron paths behave the same.
  if (r.status === "delivered" && row.tracking_status !== "delivered" && !row.step1_sample_sent) {
    try {
      await db
        .from("lab_cases")
        .update({ step1_sample_sent: true })
        .eq("id", caseId);
      await db.from("lab_events").insert({
        case_id: caseId,
        kind: "step_toggled",
        step: 1,
        completed: true,
        actor: user.email ?? "admin",
        note: "Auto-advanced: FedEx delivered sample to lab",
      });
    } catch (err) {
      console.error("[tracking] manual-refresh delivered transition failed", err);
    }
  }

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);

  return {
    ok: true,
    data: {
      status: r.status,
      detail: r.statusDetail,
      location: r.location,
      eventAtIso: r.eventAtIso,
      deliveredAtIso: r.deliveredAtIso,
    },
  };
}

/**
 * Bulk refresh, user-initiated. Wraps the shared core (also called by the
 * Vercel cron route at /api/cron/refresh-tracking) with a requireSignedIn gate
 * and revalidate on finish.
 */
export async function refreshTrackingForActiveCases(): Promise<
  ActionResult<{ polled: number; updated: number; errors: number }>
> {
  const user = await requireSignedIn();
  const { refreshTrackingForActiveCasesCore } = await import(
    "@/lib/tracking/refresh-core"
  );
  const r = await refreshTrackingForActiveCasesCore({
    actor: user.email ?? "admin",
    limit: 300,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/labs");
  return {
    ok: true,
    data: { polled: r.polled, updated: r.updated, errors: r.errors },
  };
}
