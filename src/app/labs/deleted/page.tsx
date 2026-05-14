import { requireUser } from "@/lib/auth-guard";
import { listLabCases } from "../actions";
import { BulkRecoveryTable } from "../BulkRecoveryTable";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

export default async function DeletedLabsPage() {
  const user = await requireUser();
  const cases = await listLabCases({ view: "deleted" });

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl px-6 py-4 pb-16">
        <div className="mb-3">
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Deleted cases
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {cases.length} deleted {cases.length === 1 ? "case" : "cases"} ·
            restore from here. Cases stay in the audit log permanently.
          </p>
        </div>
        <BulkRecoveryTable rows={cases} mode="deleted" />
      </main>
    </div>
  );
}
