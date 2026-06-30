import { redirect } from "next/navigation";

// The phlebotomy worklist now renders inline as a view on the main board
// (/labs?tab=phlebotomy) alongside Labs / Patients / Tracking. Keep this route
// as a permanent redirect so the old nav link and any bookmarks still land right.
export default function PhlebotomyPage() {
  redirect("/labs?tab=phlebotomy");
}
