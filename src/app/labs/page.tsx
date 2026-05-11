import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { listDistinctLabNames, listLabCases } from "./actions";
import { logoutAction } from "../login/actions";
import { KanbanBoard } from "./KanbanBoard";
import { LabKanbanBoard } from "./LabKanbanBoard";
import { LabsTabs, type LabsTab } from "./LabsTabs";
import { CaseDialog } from "./CaseDialog";
import { SearchBar } from "./SearchBar";
import { RefreshAllTrackingButton } from "./RefreshAllTrackingButton";

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
  const user = await requireAdmin();
  const sp = await searchParams;
  const q = firstString(sp.q);
  const lab = firstString(sp.lab);
  const tabParam = firstString(sp.tab);
  const tab: LabsTab = tabParam === "labs" ? "labs" : "patients";
  const hasFilters = Boolean(q || lab);

  const [cases, labNames] = await Promise.all([
    listLabCases({ view: "active", filters: { q, lab } }),
    listDistinctLabNames(),
  ]);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 lg:h-dvh lg:overflow-hidden">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Lab Tracker
            </h1>
            <p className="text-xs text-zinc-500">
              {hasFilters
                ? `${cases.length} matching ${cases.length === 1 ? "case" : "cases"}`
                : `${cases.length} active ${cases.length === 1 ? "case" : "cases"}`}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <CaseDialog mode="create" triggerLabel="+ New case" />
            <Link
              href="/labs/import"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Import
            </Link>
            <Link
              href="/labs/inbox"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Inbox
            </Link>
            <Link
              href="/labs/patients"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Patients
            </Link>
            <Link
              href="/labs/reports"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Reports
            </Link>
            <Link
              href="/labs/archived"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Archived
            </Link>
            <Link
              href="/labs/deleted"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Deleted
            </Link>
            <span className="text-zinc-600">{user.email}</span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col px-4 pb-16 pt-6 lg:min-h-0 lg:pb-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <LabsTabs tab={tab} />
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
            ) : (
              <KanbanBoard rows={cases} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
