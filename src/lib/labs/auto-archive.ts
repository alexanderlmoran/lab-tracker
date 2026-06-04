import { getSupabaseAdmin } from "@/utils/supabase/admin";

// Auto-archive cases that have finished their workflow and sat idle. "Protocol
// received" is the `closed` lane (step8 protocol emailed + step9 sales
// followup) — once a case has been there untouched for a while it's done, so we
// archive it (→ the Completed/archived bucket, off the active board, still in
// /labs/archived). Reversible (sets archived_at; unarchive restores it). No
// emails fire. Called from the daily stale-digest cron.
export async function archiveStaleProtocolReceived(
  opts: { olderThanDays?: number } = {},
): Promise<{ archived: number }> {
  const days = opts.olderThanDays ?? 21;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from("lab_cases")
    .select("id")
    .eq("step8_protocol_emailed", true)
    .eq("step9_sales_followup", true)
    .is("archived_at", null)
    .is("deleted_at", null)
    .lt("updated_at", cutoff);
  if (error) throw new Error(error.message);

  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return { archived: 0 };

  const { error: updErr } = await db
    .from("lab_cases")
    .update({ archived_at: new Date().toISOString() })
    .in("id", ids);
  if (updErr) throw new Error(updErr.message);

  await db.from("lab_events").insert(
    ids.map((id) => ({
      case_id: id,
      kind: "case_archived",
      actor: "cron:auto-archive",
      note: `Auto-archived: protocol received, idle ${days}+ days`,
    })),
  );

  return { archived: ids.length };
}
