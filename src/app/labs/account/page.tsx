import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

/**
 * Legacy redirect. The change-password form moved into
 * /labs/settings → General as of 2026-05-18. Any bookmarks or hard-coded
 * links (invite emails, temp-password instructions) keep working — they
 * just end up on the new tab.
 */
export default async function AccountPage() {
  await requireUser();
  redirect("/labs/settings?tab=general");
}
