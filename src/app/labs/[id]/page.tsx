import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-guard";
import { getLabCase } from "../actions";
import { CaseDetail } from "../CaseDetail";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

export default async function CaseFullPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const row = await getLabCase(id);
  if (!row) notFound();

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-4xl px-6 py-4 pb-12">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/labs"
              className="text-[11.5px] text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Board
            </Link>
            <h1 className="mt-0.5 truncate text-base font-semibold tracking-tight text-zinc-900">
              {row.patient_name}
            </h1>
            <p className="truncate text-xs text-zinc-500">{row.patient_email}</p>
          </div>
        </div>
        <CaseDetail row={row} />
      </main>
    </div>
  );
}
