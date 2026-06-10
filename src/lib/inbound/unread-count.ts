import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { InboundEmail } from "@/lib/types";

// Statuses that still need a human: a fresh email (pending), a parsed result
// waiting to be applied, or a notification-only email that needs a manual
// portal pull. `applied`/`dismissed`/`failed` are not "new" — they've been
// seen. Mirrors the inbox page's actionable set (backlog #15).
const ACTIONABLE: ReadonlyArray<InboundEmail["parser_status"]> = [
  "pending",
  "parsed",
  "needs_manual_pull",
];

// Same noise filter the inbox list uses (billing receipts, supply pings) so
// the badge count matches what the operator actually sees on /labs/inbox.
function isNoise(e: Pick<InboundEmail, "from_address" | "subject">): boolean {
  const from = (e.from_address ?? "").toLowerCase();
  const subj = (e.subject ?? "").toLowerCase();
  if (from.includes("billingdept@vibrant-america.com")) return true;
  if (/vibrant receipt|collection supplies|supplies ordered/.test(subj)) return true;
  return false;
}

/**
 * Count of unread / actionable inbound emails — the number rendered on the
 * Inbox nav badge in HudPulse so a new lab email is visible from every page.
 * Best-effort: any error returns 0 so the badge never breaks the header.
 */
export async function countUnreadInbox(): Promise<number> {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("inbound_emails")
      .select("from_address, subject")
      .in("parser_status", ACTIONABLE)
      .limit(500);
    if (error || !data) return 0;
    return (data as Pick<InboundEmail, "from_address" | "subject">[]).filter(
      (e) => !isNoise(e),
    ).length;
  } catch {
    return 0;
  }
}
