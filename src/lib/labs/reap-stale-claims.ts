// Stale-claim reaper for the worker job queues (pb_upload_jobs + iv_post_jobs).
//
// THE BUG: both queues claim a row by flipping 'queued' → 'claimed' and stamping
// claimed_at. The worker is then supposed to finish it (→ 'succeeded' / 'failed'
// / 'held') via the /result endpoint. But if the worker CRASHES, restarts, or
// loses its network mid-post, the row is stranded in 'claimed' forever — no
// timeout, no reaper. The case never reaches step 5 and nothing ever alerts.
//
// THE FIX: requeue any 'claimed' row whose claimed_at is older than the claim
// timeout (the worker either finished long ago or died). Bounded by attempts:
// past MAX_ATTEMPTS we mark it 'failed' with a reason instead of looping it
// forever (which would also defeat the unique-per-target index on retry).
//
// Used two ways:
//   1. As a poke-able route (/api/worker/reap-stale-claims) the Fly worker hits
//      on an interval (Vercel Hobby caps crons at once/day).
//   2. Opportunistically + cheaply at the top of /api/worker/pb-upload/next, so
//      a stranded job is freed the moment the next claim runs even if the
//      dedicated poke is late.

import { getSupabaseAdmin } from "@/utils/supabase/admin";

/** A claim older than this is considered abandoned — the worker either finished
 *  it (and the /result update was lost) or died holding it. 10 min is far longer
 *  than any healthy PB post (~5s) or IV grade, so this never races a live worker. */
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/** Past this many attempts a job is parked as 'failed' (with a reason) rather
 *  than requeued again, so a poison row can't loop forever. The drain still
 *  surfaces 'failed' jobs for a human to Retry. */
export const MAX_ATTEMPTS = 5;

type Db = ReturnType<typeof getSupabaseAdmin>;

export type ReapTableResult = {
  table: string;
  requeued: number;
  failed: number;
  error?: string;
};

export type ReapResult = {
  ok: boolean;
  reapedAt: string;
  /** Total rows moved out of 'claimed' (requeued + failed) across both queues. */
  total: number;
  tables: ReapTableResult[];
};

/** Reap one queue table. Both pb_upload_jobs and iv_post_jobs share the same
 *  claim shape (status/claimed_at/attempts/last_error), so one routine handles
 *  both. Returns the per-table counts; never throws — a bad table is reported in
 *  `error` so the other table still gets reaped. */
async function reapTable(db: Db, table: "pb_upload_jobs" | "iv_post_jobs"): Promise<ReapTableResult> {
  const cutoffIso = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
  const { data, error } = await db
    .from(table)
    .select("id, attempts, claimed_at")
    .eq("status", "claimed")
    .lt("claimed_at", cutoffIso);
  if (error) return { table, requeued: 0, failed: 0, error: error.message };

  const rows = (data ?? []) as Array<{ id: string; attempts: number | null }>;
  let requeued = 0;
  let failed = 0;
  let updateError: string | undefined;
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    const attempts = (row.attempts as number | null) ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      // Park it — too many tries. Guard on status='claimed' so we never clobber
      // a row a live worker just finished between our select and update.
      const { data: parked, error: parkErr } = await db
        .from(table)
        .update({
          status: "failed",
          last_error: `stale-claim reaper: abandoned after ${attempts} attempts (claimed > ${Math.round(CLAIM_TIMEOUT_MS / 60000)}m ago, worker likely crashed)`,
          finished_at: nowIso,
        })
        .eq("id", row.id)
        .eq("status", "claimed")
        .select("id")
        .maybeSingle();
      // Surface a genuine failure (a null `parked` with no error is just the
      // status='claimed' race — a live worker finished it first, which is fine).
      if (parkErr) updateError ??= parkErr.message;
      else if (parked) failed += 1;
    } else {
      // Requeue for another claim, BUMPING attempts here so the MAX_ATTEMPTS cap
      // is reachable no matter what the claim path does on re-claim (pb-upload's
      // claim resets attempts to 1, so without this bump a poison row would loop
      // forever). Clear claimed_at so the next reaper run doesn't immediately
      // re-reap it before a worker picks it up.
      const { data: requeuedRow, error: requeueErr } = await db
        .from(table)
        .update({ status: "queued", claimed_at: null, attempts: attempts + 1 })
        .eq("id", row.id)
        .eq("status", "claimed")
        .select("id")
        .maybeSingle();
      if (requeueErr) updateError ??= requeueErr.message;
      else if (requeuedRow) requeued += 1;
    }
  }
  return { table, requeued, failed, error: updateError };
}

/** Reap stale claims across both worker job queues. Pure DB; safe to call
 *  opportunistically (it's a single indexed select per table when nothing is
 *  stranded — the status='claimed' partial index covers it). */
export async function reapStaleClaims(): Promise<ReapResult> {
  const db = getSupabaseAdmin();
  const tables: ReapTableResult[] = [];
  for (const t of ["pb_upload_jobs", "iv_post_jobs"] as const) {
    tables.push(await reapTable(db, t));
  }
  const total = tables.reduce((n, t) => n + t.requeued + t.failed, 0);
  const ok = tables.every((t) => !t.error);
  return { ok, reapedAt: new Date().toISOString(), total, tables };
}
