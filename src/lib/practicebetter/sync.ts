import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import {
  listAllRecordsWithLog,
  type PBClientRecordSummary,
  type PBPageLog,
} from "./client";

type Variant = {
  name: string;
  query: Record<string, string>;
  cursor: "before" | "after";
};

const VARIANTS: Variant[] = [
  // PB's records list is sorted DESC, so before_id is the correct cursor.
  // We keep an after_id variant as a fallback in case PB's docs don't match
  // their server.
  { name: "default-before_id", query: {}, cursor: "before" },
  { name: "details-before_id", query: { details: "true" }, cursor: "before" },
  { name: "default-after_id", query: {}, cursor: "after" },
  { name: "details-after_id", query: { details: "true" }, cursor: "after" },
];

export type PBSyncResult = {
  ok: true;
  variantUsed: string;
  recordsSeen: number;
  pagesSeen: number;
  stoppedReason: string;
  rawItemsBeforeDedupe: number;
  pageLog: PBPageLog[];
  attempts: Array<{ variant: string; recordsSeen: number; pagesSeen: number; stoppedReason: string }>;
} | {
  ok: false;
  error: string;
  attempts: Array<{ variant: string; recordsSeen: number; pagesSeen: number; stoppedReason: string }>;
};

export async function syncPracticeBetterClients(): Promise<PBSyncResult> {
  const db = getSupabaseAdmin();
  const startedAt = new Date().toISOString();

  // Insert a sync_runs row up front so we can update it after.
  const { data: runRow, error: runErr } = await db
    .from("practicebetter_sync_runs")
    .insert({ started_at: startedAt })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return {
      ok: false,
      error: runErr?.message ?? "Could not create sync_runs row",
      attempts: [],
    };
  }
  const runId = runRow.id;

  const attempts: Array<{
    variant: string;
    recordsSeen: number;
    pagesSeen: number;
    stoppedReason: string;
  }> = [];
  let best: {
    variant: string;
    items: PBClientRecordSummary[];
    pages: PBPageLog[];
    stoppedReason: string;
  } | null = null;

  for (const v of VARIANTS) {
    try {
      const r = await listAllRecordsWithLog(v.query, {
        maxPages: 50,
        cursor: v.cursor,
      });
      attempts.push({
        variant: v.name,
        recordsSeen: r.items.length,
        pagesSeen: r.pages.length,
        stoppedReason: r.stoppedReason,
      });
      if (!best || r.items.length > best.items.length) {
        best = {
          variant: v.name,
          items: r.items,
          pages: r.pages,
          stoppedReason: r.stoppedReason,
        };
      }
    } catch (err) {
      attempts.push({
        variant: v.name,
        recordsSeen: 0,
        pagesSeen: 0,
        stoppedReason: `error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`,
      });
    }
  }

  if (!best || best.items.length === 0) {
    const msg = `All sync variants returned 0 records. Attempts: ${JSON.stringify(attempts)}`;
    await db
      .from("practicebetter_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        error_message: msg,
        diagnostics: { attempts },
      })
      .eq("id", runId);
    return { ok: false, error: msg, attempts };
  }

  // Dedupe by record_id before upserting. PB's after_id pagination can return
  // the same boundary record twice (last item of page N == first item of page
  // N+1), and Postgres rejects upserts that hit the same primary key twice in
  // one batch.
  const byId = new Map<string, PBClientRecordSummary>();
  for (const it of best.items) {
    if (it.id) byId.set(it.id, it);
  }
  const dedupedItems = [...byId.values()];

  const rows = dedupedItems.map((it) => {
    const email =
      it.profile?.emailAddress?.trim() ?? it.client?.emailAddress?.trim() ?? null;
    return {
      record_id: it.id,
      email_lowered: email ? email.toLowerCase() : null,
      first_name: it.profile?.firstName ?? null,
      last_name: it.profile?.lastName ?? null,
      status: it.status ?? null,
      is_child_record:
        // @ts-expect-error — schema includes isChildRecord at top level; not in our trimmed type
        Boolean(it.isChildRecord ?? false),
      raw: it as unknown as Record<string, unknown>,
      last_synced_at: new Date().toISOString(),
    };
  });

  // Chunk to avoid huge single requests.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await db
      .from("practicebetter_clients")
      .upsert(chunk, { onConflict: "record_id" });
    if (error) {
      await db
        .from("practicebetter_sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          error_message: `Upsert failed at chunk ${i}: ${error.message}`,
          records_seen: best.items.length,
          pages_seen: best.pages.length,
          variant_used: best.variant,
          diagnostics: { attempts, pages: best.pages },
        })
        .eq("id", runId);
      return {
        ok: false,
        error: `Upsert failed: ${error.message}`,
        attempts,
      };
    }
  }

  const stoppedEarly = best.stoppedReason === "max_pages_hit";

  await db
    .from("practicebetter_sync_runs")
    .update({
      finished_at: new Date().toISOString(),
      records_seen: dedupedItems.length,
      pages_seen: best.pages.length,
      variant_used: best.variant,
      stopped_early: stoppedEarly,
      diagnostics: {
        attempts,
        pages: best.pages,
        rawItemsBeforeDedupe: best.items.length,
      },
    })
    .eq("id", runId);

  return {
    ok: true,
    variantUsed: best.variant,
    recordsSeen: dedupedItems.length,
    pagesSeen: best.pages.length,
    stoppedReason: best.stoppedReason,
    pageLog: best.pages,
    attempts,
    rawItemsBeforeDedupe: best.items.length,
  };
}

export async function getLatestPracticeBetterSync(): Promise<{
  finishedAt: string | null;
  recordsSeen: number;
  variantUsed: string | null;
  stoppedEarly: boolean;
  cachedRecordCount: number;
} | null> {
  const db = getSupabaseAdmin();
  const [{ data: run }, { count }] = await Promise.all([
    db
      .from("practicebetter_sync_runs")
      .select("finished_at, records_seen, variant_used, stopped_early")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("practicebetter_clients")
      .select("record_id", { count: "exact", head: true }),
  ]);
  return {
    finishedAt: run?.finished_at ?? null,
    recordsSeen: run?.records_seen ?? 0,
    variantUsed: run?.variant_used ?? null,
    stoppedEarly: Boolean(run?.stopped_early),
    cachedRecordCount: count ?? 0,
  };
}
