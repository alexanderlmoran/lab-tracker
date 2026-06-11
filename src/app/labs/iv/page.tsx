import { requireUser } from "@/lib/auth-guard";
import { HudPulse } from "../HudPulse";
import { listHeldIvPosts, listIvSessions, type HeldIvPost, type IvSessionRow } from "./actions";
import { HeldReview } from "./HeldReview";
import { IvChartingBoard } from "./IvChartingBoard";

export const dynamic = "force-dynamic";

/** YYYY-MM-DD for "today" in clinic time (America/New_York). */
function todayEastern(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function IvChartingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const date = firstString(sp.date) ?? todayEastern();

  let rows: IvSessionRow[] = [];
  let loadError: string | null = null;
  try {
    rows = await listIvSessions(date);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  // Held posts span all days (a backlog to clear) — load independently so a
  // missing table on either query doesn't break the other.
  let held: HeldIvPost[] = [];
  try {
    held = await listHeldIvPosts();
  } catch {
    /* table not created yet, or transient — just hide the panel */
  }

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <HudPulse user={user} cases={[]} />
      <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-16 pt-3">
        <HeldReview held={held} />
        <IvChartingBoard rows={rows} date={date} loadError={loadError} />
      </main>
    </div>
  );
}
