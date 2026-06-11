import { requireUser } from "@/lib/auth-guard";
import { HudPulse } from "../../HudPulse";
import { getIvSession } from "../actions";
import { IvChartForm } from "./IvChartForm";

export const dynamic = "force-dynamic";

export default async function IvSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const session = await getIvSession(id).catch(() => null);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <HudPulse user={user} cases={[]} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-20 pt-4">
        {session ? (
          <IvChartForm session={session} />
        ) : (
          <p className="text-sm text-zinc-600">IV session not found.</p>
        )}
      </main>
    </div>
  );
}
