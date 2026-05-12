import Link from "next/link";
import { requireSignedIn } from "@/lib/auth-guard";
import { listLabCases } from "../actions";
import { logoutAction } from "../../login/actions";
import { CaseTable } from "../CaseTable";

export const dynamic = "force-dynamic";

export default async function DeletedLabsPage() {
  const user = await requireSignedIn();
  const cases = await listLabCases({ view: "deleted" });

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Deleted cases
            </h1>
            <p className="text-xs text-zinc-500">
              Restore from here. Cases stay in the audit log permanently.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/labs"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Back to active
            </Link>
            <Link
              href="/labs/archived"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Archived
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

      <main className="mx-auto mt-8 max-w-7xl px-6 pb-16">
        <h2 className="mb-4 text-sm font-semibold text-zinc-900">
          {cases.length} deleted {cases.length === 1 ? "case" : "cases"}
        </h2>
        <CaseTable rows={cases} />
      </main>
    </div>
  );
}
