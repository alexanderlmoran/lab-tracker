import { requireUser } from "@/lib/auth-guard";
import { HudPulse } from "../HudPulse";
import {
  listAddablePhlebotomyCases,
  listPhlebotomyBoard,
  type PhlebApptRow,
} from "./actions";
import { PhlebotomyBoard } from "./PhlebotomyBoard";

export const dynamic = "force-dynamic";

export default async function PhlebotomyPage() {
  const user = await requireUser();

  let rows: PhlebApptRow[] = [];
  let addable: Awaited<ReturnType<typeof listAddablePhlebotomyCases>> = [];
  let loadError: string | null = null;
  try {
    [rows, addable] = await Promise.all([
      listPhlebotomyBoard(),
      listAddablePhlebotomyCases(),
    ]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 lg:h-dvh lg:overflow-hidden">
      <HudPulse user={user} cases={[]} />
      <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col px-4 pb-16 pt-3 lg:min-h-0 lg:pb-4">
        <div className="mb-3">
          <h1 className="text-sm font-semibold text-zinc-900">Mobile Phlebotomy</h1>
          <p className="text-xs text-zinc-500">
            Schedule in-home draws for patients who can&apos;t self-collect — vendor, appointment,
            cost, and the post-draw &ldquo;smooth &amp; complete&rdquo; confirmation.
          </p>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">
            Couldn&rsquo;t load the phlebotomy board: {loadError}
            {/migration|column|relation|does not exist|phlebotomy_appointments/i.test(loadError) ? (
              <div className="mt-1 text-rose-600">
                Apply migration <code>20260630_phlebotomy_appointments.sql</code> (and the
                <code> _event_kind</code> enum migration) to the database.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex-1 lg:min-h-0">
            <PhlebotomyBoard rows={rows} addable={addable} />
          </div>
        )}
      </main>
    </div>
  );
}
