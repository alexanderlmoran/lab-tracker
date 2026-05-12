import Link from "next/link";
import { requireSignedIn } from "@/lib/auth-guard";
import { ImportClient } from "./ImportClient";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireSignedIn();
  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Bulk import
            </h1>
            <p className="text-xs text-zinc-500">
              Lab Shipping CSV → step-1 cases. 2026 rows only; multi-patient
              rows are split. PB matches auto-fill email/phone/DOB.
            </p>
          </div>
          <Link
            href="/labs"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            ← Back to board
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <ImportClient />
      </main>
    </div>
  );
}
