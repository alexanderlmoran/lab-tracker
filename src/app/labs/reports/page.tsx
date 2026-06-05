// The Reports page became the "Reports" sub-tab of Analytics (2026-06-05).
// Keep this route as a permanent redirect so old links/bookmarks still land.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ReportsRedirect() {
  redirect("/labs/analytics");
}
