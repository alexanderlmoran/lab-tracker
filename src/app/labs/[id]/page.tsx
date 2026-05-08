import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { getLabCase } from "../actions";
import { logoutAction } from "../../login/actions";
import { CaseDetail } from "../CaseDetail";

export const dynamic = "force-dynamic";

export default async function CaseFullPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAdmin();
  const row = await getLabCase(id);
  if (!row) notFound();

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div>
            <Link
              href="/labs"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Back to board
            </Link>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-zinc-900">
              {row.patient_name}
            </h1>
            <p className="text-xs text-zinc-500">{row.patient_email}</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
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

      <main className="mx-auto max-w-4xl px-6 py-8">
        <CaseDetail row={row} />
      </main>
    </div>
  );
}
