// Core "refresh tracking for active cases" logic, extracted from the user-
// facing server action so the Vercel cron route can call it without going
// through requireSignedIn (cron has no user; it auths via CRON_SECRET on the
// route handler).
//
// No "use server" directive here on purpose — this is a plain library
// function, callable from server actions and route handlers alike.

import { getSupabaseAdmin } from "@/utils/supabase/admin";
import {
  fedexTrackBatch,
  isFedExConfigured,
  type FedExTrackResult,
} from "./fedex";
import type { TrackingStatus } from "@/lib/types";

type CaseRow = {
  id: string;
  tracking_number: string | null;
  tracking_status: TrackingStatus | null;
  step1_sample_sent?: boolean;
};

/**
 * Called when a case's tracking status transitions to `delivered` (i.e. the
 * sample just reached the lab). Two effects:
 *   1. If step 1 ("Sample sent to lab") isn't already ticked, mark it true.
 *      Staff sometimes forget to tick it manually; FedEx delivery is definitive
 *      proof the sample shipped, so this closes the gap without staff action.
 *   2. Insert a `step_toggled` audit event so the timeline records that
 *      automation (not a human) advanced the step.
 *
 * Best-effort: any error is logged and swallowed so the calling refresh loop
 * doesn't blow up on one bad row.
 */
async function onDeliveredTransition(args: {
  db: ReturnType<typeof getSupabaseAdmin>;
  caseId: string;
  actor: string;
  step1AlreadyDone: boolean;
}): Promise<void> {
  if (args.step1AlreadyDone) return;
  try {
    await args.db
      .from("lab_cases")
      .update({ step1_sample_sent: true })
      .eq("id", args.caseId);
    await args.db.from("lab_events").insert({
      case_id: args.caseId,
      kind: "step_toggled",
      step: 1,
      completed: true,
      actor: args.actor,
      note: "Auto-advanced: FedEx delivered sample to lab",
    });
  } catch (err) {
    console.error("[tracking] onDeliveredTransition failed", err);
  }
}

function mergeUpdate(result: FedExTrackResult, existing: CaseRow) {
  if (result.status === "unknown" && existing.tracking_status === "delivered") {
    return null;
  }
  return {
    tracking_carrier: "fedex" as const,
    tracking_status: result.status,
    tracking_status_detail: result.statusDetail,
    tracking_event_at: result.eventAtIso,
    tracking_location: result.location,
    tracking_polled_at: new Date().toISOString(),
    tracking_delivered_at: result.deliveredAtIso ?? null,
  };
}

export type RefreshSummary = {
  ok: true;
  polled: number;
  updated: number;
  errors: number;
} | {
  ok: false;
  error: string;
};

/**
 * Core poll loop. Called by the user-facing server action and by the cron
 * route. Auth is the caller's responsibility.
 *
 * `actor` is recorded on each lab_events row so the audit trail distinguishes
 * "user clicked Refresh" ("admin@centnerhb.com") from "cron polled" ("cron").
 */
export async function refreshTrackingForActiveCasesCore(opts: {
  actor: string;
  limit?: number;
}): Promise<RefreshSummary> {
  if (!isFedExConfigured()) {
    return { ok: false, error: "FedEx not configured" };
  }
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from("lab_cases")
    .select("id, tracking_number, tracking_status, step1_sample_sent")
    .is("deleted_at", null)
    .is("archived_at", null)
    .not("tracking_number", "is", null)
    .or("tracking_status.is.null,tracking_status.neq.delivered")
    .order("tracking_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) return { ok: false, error: error.message };

  const cases = (data ?? []) as CaseRow[];
  if (cases.length === 0) {
    return { ok: true, polled: 0, updated: 0, errors: 0 };
  }

  let polled = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < cases.length; i += 30) {
    const chunk = cases.slice(i, i + 30);
    const numbers = chunk.map((c) => c.tracking_number!).filter(Boolean);
    let results: FedExTrackResult[];
    try {
      results = await fedexTrackBatch(numbers);
    } catch {
      errors += chunk.length;
      continue;
    }
    polled += chunk.length;
    const byNumber = new Map(results.map((r) => [r.trackingNumber, r]));
    for (const c of chunk) {
      const r = c.tracking_number ? byNumber.get(c.tracking_number) : undefined;
      if (!r) continue;
      const update = mergeUpdate(r, c);
      if (!update) continue;
      const { error: updateErr } = await db
        .from("lab_cases")
        .update(update)
        .eq("id", c.id);
      if (updateErr) {
        errors += 1;
        continue;
      }
      updated += 1;
      // Per-case audit so the timeline shows when status flipped.
      await db.from("lab_events").insert({
        case_id: c.id,
        kind: "tracking_refreshed",
        actor: opts.actor,
        note: `${r.status}${r.location ? ` · ${r.location}` : ""}${r.statusDetail ? ` — ${r.statusDetail}` : ""}`,
      });
      // First-time delivered transition: ensure step 1 is ticked.
      if (r.status === "delivered" && c.tracking_status !== "delivered") {
        await onDeliveredTransition({
          db,
          caseId: c.id,
          actor: opts.actor,
          step1AlreadyDone: Boolean(c.step1_sample_sent),
        });
      }
    }
  }

  return { ok: true, polled, updated, errors };
}
