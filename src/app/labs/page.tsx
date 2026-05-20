import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { listDistinctLabNames, listLabCases, listPatientCases } from "./actions";
import { getCardCountsForCases } from "./draw-actions";
import { parseSinceKey, sinceDaysForKey } from "./time-range";
import { LabKanbanBoard } from "./LabKanbanBoard";
import { TrackingBoard } from "./TrackingBoard";
import { PatientFocusBoard } from "./PatientFocusBoard";
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
    tabParam === "patients" || tabParam === "tracking" ? tabParam : "labs";
  const sinceParam = firstString(sp.since);
  const since = parseSinceKey(sinceParam);
  const sinceDays = sinceDaysForKey(since);
  const hasFilters = Boolean(q || lab || sinceDays);
  const focusedPatient = tab === "patients" ? firstString(sp.patient) ?? null : null;

  // Patient-focus mode pulls a single patient's full history (active +
  // archived). Skip the standard active-case query in that case — it's
  // wasteful and would override the focused dataset.
  //
  // Archived cases populate the "Completed" lane on the By-Lab board.
  // We honor the same time-window filter so the lane doesn't unbound
  // ("All time" still shows them all).
  const [activeCases, archivedCases, labNames, focusedCases] = await Promise.all([
    focusedPatient
      ? Promise.resolve([])
      : listLabCases({
          view: "active",
          filters: { q, lab, sinceDays: sinceDays ?? undefined },
        }),
    focusedPatient
      ? Promise.resolve([])
      : listLabCases({
          view: "archived",
          filters: { q, lab, sinceDays: sinceDays ?? undefined },
        }),
    listDistinctLabNames(),
    focusedPatient ? listPatientCases(focusedPatient) : Promise.resolve([]),
  ]);
  // By-Lab board includes archived (they sit in the "Completed" lane).
  // Tracking board only cares about active shipments — archived would
  // clutter it. HudPulse and the count chip reflect active-only.
  const labBoardCases = [...activeCases, ...archivedCases];
  const cases = activeCases;

  // Touch counts (open contact attempts + emails sent) for the kanban cards.
  // One batched query for everything currently visible — falls back to
  // {} if it throws so an analytics hiccup never breaks the board.
  const cardCounts = await getCardCountsForCases(
    Array.from(new Set([...labBoardCases, ...focusedCases].map((c) => c.id))),
  ).catch(() => ({}));

  const isPatientFocus = tab === "patients";
  const focusedPatientName = focusedCases[0]?.patient_name ?? null;
  const focusedRows = focusedCases.map((c) => ({
    ...c,
    archived: Boolean(c.archived_at),
  }));

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 lg:h-dvh lg:overflow-hidden">
      <HudPulse user={user} cases={cases} />

      <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col px-4 pb-16 pt-3 lg:min-h-0 lg:pb-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <LabsTabs tab={tab} />
          {!isPatientFocus ? (
            <>
              <TimeRangeTabs since={since} />
              <div className="text-xs text-zinc-500 tabular-nums">
                {hasFilters
                  ? `${cases.length} matching ${cases.length === 1 ? "case" : "cases"}`
                  : `${cases.length} active ${cases.length === 1 ? "case" : "cases"}`}
              </div>
              <div className="flex-1 min-w-0">
                <SearchBar labNames={labNames} />
              </div>
              <Link
                href="/labs/archived"
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                Archive →
              </Link>
              <RefreshAllTrackingButton />
            </>
          ) : null}
        </div>

        {isPatientFocus ? (
          <div className="flex-1 lg:min-h-0">
            <PatientFocusBoard
              initialEmail={focusedPatient}
              initialCases={focusedRows}
              initialName={focusedPatientName}
              counts={cardCounts}
            />
          </div>
        ) : (tab === "labs" ? labBoardCases : cases).length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-600">
              {hasFilters ? "No cases match your filters." : "No cases yet."}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {hasFilters ? (
                <>Try clearing the search.</>
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
              <LabKanbanBoard rows={labBoardCases} counts={cardCounts} />
            ) : (
              <TrackingBoard rows={cases} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
