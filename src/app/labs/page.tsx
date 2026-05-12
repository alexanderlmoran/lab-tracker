import { requireUser } from "@/lib/auth-guard";
import { listDistinctLabNames, listLabCases } from "./actions";
import { parseSinceKey, sinceDaysForKey } from "./time-range";
import { KanbanBoard } from "./KanbanBoard";
import { LabKanbanBoard } from "./LabKanbanBoard";
import { TrackingBoard } from "./TrackingBoard";
import { LabsTabs, type LabsTab } from "./LabsTabs";
import { TimeRangeTabs } from "./TimeRangeTabs";
import { SearchBar } from "./SearchBar";
import { RefreshAllTrackingButton } from "./RefreshAllTrackingButton";
import { HudPulse } from "./HudPulse";

export const dynamic = "force-dynamic";

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function LabsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = firstString(sp.q);
  const lab = firstString(sp.lab);
  const tabParam = firstString(sp.tab);
  const tab: LabsTab =
    tabParam === "labs" || tabParam === "tracking" ? tabParam : "patients";
  const sinceParam = firstString(sp.since);
  const since = parseSinceKey(sinceParam);
  const sinceDays = sinceDaysForKey(since);
  const hasFilters = Boolean(q || lab || sinceDays);

  const [cases, labNames] = await Promise.all([
    listLabCases({
      view: "active",
      filters: { q, lab, sinceDays: sinceDays ?? undefined },
    }),
    listDistinctLabNames(),
  ]);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 lg:h-dvh lg:overflow-hidden">
      <HudPulse user={user} cases={cases} />

      <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col px-4 pb-16 pt-6 lg:min-h-0 lg:pb-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="text-xs text-zinc-500">
            {hasFilters
              ? `${cases.length} matching ${cases.length === 1 ? "case" : "cases"}`
              : `${cases.length} active ${cases.length === 1 ? "case" : "cases"}`}
          </div>
          <LabsTabs tab={tab} />
          <TimeRangeTabs since={since} />
          <div className="flex-1 min-w-0">
            <SearchBar labNames={labNames} />
          </div>
          <RefreshAllTrackingButton />
        </div>
        {cases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-600">
              {hasFilters ? "No cases match your filters." : "No cases yet."}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {hasFilters ? (
                <>
                  Try clearing the search.
                </>
              ) : (
                <>
                  Click <span className="font-medium">+ New case</span> to
                  create one.
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="flex-1 lg:min-h-0">
            {tab === "labs" ? (
              <LabKanbanBoard rows={cases} />
            ) : tab === "tracking" ? (
              <TrackingBoard rows={cases} />
            ) : (
              <KanbanBoard rows={cases} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
