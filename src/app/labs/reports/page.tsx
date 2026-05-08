import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { getReportData } from "../actions";
import { logoutAction } from "../../login/actions";
import { COLUMN_LABEL, COLUMN_ORDER } from "@/lib/columns";

export const dynamic = "force-dynamic";

function StatCard({
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

function HBar({
  label,
  value,
  max,
  hue,
}: {
  label: string;
  value: number;
  max: number;
  hue: "zinc" | "emerald" | "amber" | "red" | "blue";
}) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  const hueClass = {
    zinc: "bg-zinc-400",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    blue: "bg-blue-500",
  }[hue];
  return (
    <div className="grid grid-cols-[140px_1fr_40px] items-center gap-3 text-sm">
      <span className="truncate text-zinc-700">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
        <div
          className={`h-full ${hueClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-right text-xs tabular-nums text-zinc-600">
        {value}
      </span>
    </div>
  );
}

function SparkBar({
  data,
}: {
  data: Array<{ day: string; sent: number; failed: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.sent + d.failed));
  return (
    <div className="flex items-end gap-1">
      {data.map((d) => {
        const sentH = (d.sent / max) * 60;
        const failH = (d.failed / max) * 60;
        const day = d.day.slice(5);
        return (
          <div
            key={d.day}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.day}: ${d.sent} sent, ${d.failed} failed`}
          >
            <div className="flex h-[60px] w-full flex-col-reverse">
              {d.sent > 0 ? (
                <div
                  className="w-full rounded-t bg-emerald-500"
                  style={{ height: `${sentH}px` }}
                />
              ) : null}
              {d.failed > 0 ? (
                <div
                  className="w-full rounded-t bg-red-500"
                  style={{ height: `${failH}px` }}
                />
              ) : null}
            </div>
            <span className="text-[9px] text-zinc-500">{day}</span>
          </div>
        );
      })}
    </div>
  );
}

export default async function ReportsPage() {
  const user = await requireAdmin();
  const data = await getReportData();
  const maxColumn = Math.max(1, ...Object.values(data.columnCounts));
  const maxLab = Math.max(1, ...data.byLab.map((l) => l.count));
  const totalEmails =
    data.emailStats.sent + data.emailStats.failed + data.emailStats.skipped;
  const successRate =
    totalEmails === 0
      ? "—"
      : `${Math.round((data.emailStats.sent / totalEmails) * 100)}%`;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Reports
            </h1>
            <p className="text-xs text-zinc-500">Snapshot of all-time data.</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/labs"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Cases
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

      <main className="mx-auto mt-6 max-w-7xl space-y-6 px-6 pb-16">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Active cases"
            value={data.totals.active}
            hint={`${data.totals.total} all-time`}
          />
          <StatCard label="Archived" value={data.totals.archived} />
          <StatCard label="Deleted" value={data.totals.deleted} />
          <StatCard
            label="Email success rate"
            value={successRate}
            hint={`${data.emailStats.sent} sent / ${data.emailStats.failed} failed / ${data.emailStats.skipped} skipped`}
          />
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">
              Active cases by column
            </h2>
            <div className="space-y-2">
              {COLUMN_ORDER.map((col) => (
                <HBar
                  key={col}
                  label={COLUMN_LABEL[col]}
                  value={data.columnCounts[col] ?? 0}
                  max={maxColumn}
                  hue="zinc"
                />
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">
              Volume by lab
            </h2>
            {data.byLab.length === 0 ? (
              <p className="text-sm text-zinc-500">No data yet.</p>
            ) : (
              <div className="space-y-2">
                {data.byLab.slice(0, 8).map((l) => (
                  <HBar
                    key={l.lab_name}
                    label={l.lab_name}
                    value={l.count}
                    max={maxLab}
                    hue="blue"
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900">
            Email sends — last 14 days
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            <span className="mr-3 inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Sent
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-red-500" /> Failed
            </span>
          </p>
          <SparkBar data={data.recentSendsByDay} />
        </section>
      </main>
    </div>
  );
}
