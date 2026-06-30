import { requireUser } from "@/lib/auth-guard";
import {
  listDistinctLabNames,
  listDistinctPanels,
  listLabCases,
  listPatientCases,
} from "./actions";
import { listCaseIdsWithPendingPdf } from "./pdf-actions";
import { getCardCountsForCases } from "./draw-actions";
import { parseSinceKey, sinceDaysForKey } from "./time-range";
import { LabKanbanBoard } from "./LabKanbanBoard";
import { TrackingBoard } from "./TrackingBoard";
import { PatientFocusBoard } from "./PatientFocusBoard";
import { LabsTabs, type LabsTab } from "./LabsTabs";
import { TimeRangeTabs } from "./TimeRangeTabs";
import { SearchBar } from "./SearchBar";
import { LabFilterSelect } from "./LabFilterSelect";
import { TestFilterSelect } from "./TestFilterSelect";
import { DateGroupToggle } from "./DateGroupToggle";
import { MergeViewMenu } from "./MergeViewMenu";
import { KanbanFilterChips } from "./KanbanFilterChips";
import { RefreshAllTrackingButton } from "./RefreshAllTrackingButton";
import { SchedulePickupButton } from "./SchedulePickupButton";
import { HudPulse } from "./HudPulse";
import { LabsLegend } from "./LabsLegend";
import { CaseDialog } from "./CaseDialog";
import { InboxNotice } from "./InboxNotice";
import { countUnreadInbox } from "@/lib/inbound/unread-count";

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
  const test = firstString(sp.test);
  const tabParam = firstString(sp.tab);
  const tab: LabsTab =
    tabParam === "patients" || tabParam === "tracking" ? tabParam : "labs";
  const sinceParam = firstString(sp.since);
  const since = parseSinceKey(sinceParam);
  const sinceDays = sinceDaysForKey(since);
  const hasFilters = Boolean(q || lab || test || sinceDays);
  const focusedPatient = tab === "patients" ? firstString(sp.patient) ?? null : null;

  // Patient-focus mode pulls a single patient's full history (active +
  // archived). Skip the standard active-case query in that case — it's
  // wasteful and would override the focused dataset.
  //
  // Archived cases populate the "Completed" lane on the By-Lab board.
  // We honor the same time-window filter so the lane doesn't unbound
  // ("All time" still shows them all).
  const [activeCases, archivedCases, labNames, panelNames, focusedCases] =
    await Promise.all([
      focusedPatient
        ? Promise.resolve([])
        : listLabCases({
            view: "active",
            filters: { q, lab, test, sinceDays: sinceDays ?? undefined },
          }),
      focusedPatient
        ? Promise.resolve([])
        : listLabCases({
            view: "archived",
            filters: { q, lab, test, sinceDays: sinceDays ?? undefined },
          }),
      // The lab/test dropdowns only render off the patients tab — skip the two
      // full-table scans that feed them when they won't be shown.
      tab === "patients" ? Promise.resolve([]) : listDistinctLabNames(),
      tab === "patients" ? Promise.resolve([]) : listDistinctPanels(),
      focusedPatient ? listPatientCases(focusedPatient) : Promise.resolve([]),
    ]);
  // By-Lab board includes archived (they sit in the "Completed" lane).
  // Tracking board only cares about active shipments — archived would
  // clutter it. HudPulse and the count chip reflect active-only.
  const labBoardCases = [...activeCases, ...archivedCases];
  const cases = activeCases;

  // Secondary lookups for the visible cases, IN PARALLEL — these were three
  // sequential awaits, which added a full Supabase round-trip each to EVERY
  // render. router.refresh() re-runs this whole page after each click, so
  // this is the main lever on click→render latency.
  //   - cardCounts: touch counts (open contact attempts + emails) per card
  //   - pendingPdfCaseIds: PDFs awaiting Approve (drives Pending Upload lane)
  //   - unreadInbox: inbound lab emails banner (backlog #15)
  // Each falls back benignly so an analytics hiccup never breaks the board.
  const visibleIds = Array.from(
    new Set([...labBoardCases, ...focusedCases].map((c) => c.id)),
  );
  const [cardCounts, pendingPdfCaseIds, unreadInbox] = await Promise.all([
    getCardCountsForCases(visibleIds).catch(() => ({})),
    listCaseIdsWithPendingPdf(visibleIds).catch(() => [] as string[]),
    countUnreadInbox().catch(() => 0),
  ]);

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
        <InboxNotice count={unreadInbox} />
        <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
          <CaseDialog
            mode="create"
            triggerLabel="+ New case"
            triggerClassName="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900 transition-colors hover:bg-zinc-100"
          />
          <LabsTabs tab={tab} />
          {!isPatientFocus ? (
            <>
              {tab === "labs" ? <MergeViewMenu /> : null}
              {tab === "labs" ? <DateGroupToggle /> : null}
              <div className="min-w-[160px] max-w-xs flex-1">
                <SearchBar />
              </div>
              <LabFilterSelect labNames={labNames} />
              <TestFilterSelect panels={panelNames} />
              <TimeRangeTabs since={since} />
              {tab === "labs" ? <KanbanFilterChips /> : null}
              <RefreshAllTrackingButton />
              <SchedulePickupButton cases={cases} />
              <span className="ml-auto">
                <LabsLegend />
              </span>
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
              <LabKanbanBoard
                rows={labBoardCases}
                counts={cardCounts}
                pendingPdfCaseIds={pendingPdfCaseIds}
              />
            ) : (
              <TrackingBoard rows={cases} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
