// Team sub-tab — per-person activity. Answers "who did what, and how much"
// (e.g. "I did 12–18 cards the other day"). Server component; the window
// selector is its own client component.
//
// Identity caveat surfaced in the UI: actor columns are text labels, not FKs
// to auth.users, so bot/system actions are bucketed as "Automated" and human
// identities are best-effort (see normalizeActor in data.ts).

import type { TeamActivity, ActorActivity } from "./data";
import { TeamWindowSelector } from "./TeamWindowSelector";

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function PerDayBars({
  data,
}: {
  data: Array<{ day: string; human: number; automated: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.human + d.automated));
  return (
    <div className="flex items-end gap-1">
      {data.map((d) => {
        const humanH = (d.human / max) * 80;
        const autoH = (d.automated / max) * 80;
        return (
          <div
            key={d.day}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.day}: ${d.human} by people, ${d.automated} automated`}
          >
            <div className="flex h-[80px] w-full flex-col-reverse">
              {d.human > 0 ? (
                <div
                  className="w-full rounded-t bg-indigo-500"
                  style={{ height: `${humanH}px` }}
                />
              ) : null}
              {d.automated > 0 ? (
                <div
                  className="w-full bg-zinc-300"
                  style={{ height: `${autoH}px` }}
                />
              ) : null}
            </div>
            <span className="text-[9px] text-zinc-500">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Num({ n }: { n: number }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
      {n === 0 ? <span className="text-zinc-300">0</span> : n}
    </td>
  );
}

export function TeamView({ activity }: { activity: TeamActivity }) {
  const humans = activity.actors.filter((a) => a.kind === "human");
  const bots = activity.actors.filter((a) => a.kind === "automated");
  const topHuman = humans[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Actions recorded per person across approvals, step changes, emails and
          edits.
        </p>
        <TeamWindowSelector windowDays={activity.windowDays} />
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard
          label="Total actions"
          value={activity.totalActions}
          hint={`last ${activity.windowDays === 1 ? "24h" : `${activity.windowDays} days`}`}
        />
        <SummaryCard label="By people" value={activity.humanActions} />
        <SummaryCard label="Automated" value={activity.automatedActions} />
        <SummaryCard
          label="Most active"
          value={topHuman ? topHuman.actor : "—"}
          hint={topHuman ? `${topHuman.total} actions` : undefined}
        />
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900">
          Activity by day
        </h2>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="mr-3 inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-indigo-500" /> People
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-zinc-300" /> Automated
          </span>
        </p>
        <PerDayBars data={activity.perDay} />
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-900">
          Per person
        </h2>
        {activity.actors.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No recorded activity in this window.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">Person</th>
                <th className="px-3 py-2 text-right font-medium">Approvals</th>
                <th className="px-3 py-2 text-right font-medium">Steps</th>
                <th className="px-3 py-2 text-right font-medium">Emails</th>
                <th className="px-3 py-2 text-right font-medium">Cases</th>
                <th className="px-3 py-2 text-right font-medium">Corrections</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...humans, ...bots].map((a: ActorActivity) => (
                <tr
                  key={a.actor}
                  className="border-b border-zinc-50 last:border-0"
                >
                  <td className="px-4 py-2">
                    <span className="text-zinc-900">{a.actor}</span>
                    {a.kind === "automated" ? (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                        bot
                      </span>
                    ) : null}
                  </td>
                  <Num n={a.approvals} />
                  <Num n={a.stepsAdvanced} />
                  <Num n={a.emails} />
                  <Num n={a.casesTouched} />
                  <Num n={a.corrections} />
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-zinc-900">
                    {a.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
          Identity is derived from text actor labels (not user accounts), so
          automated and system actions are grouped as “Automated”. Good enough
          for a small team; a per-user link can be added later.
        </p>
      </section>
    </div>
  );
}
