import { requireUser } from "@/lib/auth-guard";
import { ImportClient } from "./ImportClient";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireUser();
  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-screen-2xl px-4 py-4">
        <div className="mb-3">
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Bulk import
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            Lab Shipping CSV → step-1 cases. 2026 rows only; multi-patient rows
            are split. PB matches auto-fill email/phone/DOB.
          </p>
        </div>
        <ImportClient />
      </main>
    </div>
  );
}
