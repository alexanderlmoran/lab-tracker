// Revenue sub-tab — sell-price revenue, volume, and a rough margin across all
// non-deleted cases. Prices come from src/lib/labs/pricing.ts (Zenoti sell
// list); costs are approximate, so margin is labelled an estimate.

import type { RevenueData } from "./data";
import { formatUsd } from "@/lib/labs/pricing";

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function Bar({ label, value, sub, max }: { label: string; value: number; sub: string; max: number }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-36 shrink-0 truncate text-xs text-zinc-700" title={label}>{label}</div>
      <div className="relative h-5 flex-1 overflow-hidden rounded bg-zinc-100">
        <div className="absolute inset-y-0 left-0 rounded bg-emerald-400/70" style={{ width: `${pct}%` }} />
      </div>
      <div className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-900">{formatUsd(value)}</div>
      <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-zinc-400">{sub}</div>
    </div>
  );
}

export function RevenueView({ data }: { data: RevenueData }) {
  const margin = data.totalRevenue - data.totalCost;
  const pricedPct = data.totalCount ? Math.round((100 * data.pricedCount) / data.totalCount) : 0;
  const maxLab = Math.max(1, ...data.byLab.map((l) => l.revenue));
  const maxMonth = Math.max(1, ...data.byMonth.map((m) => m.revenue));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total revenue" value={formatUsd(data.totalRevenue)} hint={`${data.totalCount} orders`} />
        <StatCard label="Est. margin" value={formatUsd(margin)} hint="approx — costs incomplete" />
        <StatCard label="Avg / order" value={formatUsd(data.totalCount ? Math.round(data.totalRevenue / data.totalCount) : 0)} />
        <StatCard label="Priced" value={`${pricedPct}%`} hint={`${data.unpricedCount} unpriced`} />
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900">Revenue by lab</h2>
        <div className="divide-y divide-zinc-100">
          {data.byLab.filter((l) => l.revenue > 0).slice(0, 16).map((l) => (
            <Bar key={l.lab} label={l.lab} value={l.revenue} sub={`${l.count}×`} max={maxLab} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900">Revenue by month</h2>
        {data.byMonth.length === 0 ? (
          <p className="text-xs text-zinc-500">No dated orders.</p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {data.byMonth.map((m) => (
              <Bar key={m.month} label={m.month} value={m.revenue} sub={`${m.count}×`} max={maxMonth} />
            ))}
          </div>
        )}
      </section>

      {data.topUnpriced.length ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-1 text-sm font-semibold text-amber-900">Unpriced ({data.unpricedCount} orders)</h2>
          <p className="mb-2 text-xs text-amber-800">
            These have no panel/service to map to a price (e.g. a generic &ldquo;Vibrant&rdquo;). Revenue above
            excludes them — add prices in <code>src/lib/labs/pricing.ts</code> or set the panel on the case.
          </p>
          <ul className="text-xs text-amber-900">
            {data.topUnpriced.map((u) => (
              <li key={u.key} className="flex justify-between gap-2 py-0.5">
                <span className="truncate">{u.key}</span>
                <span className="shrink-0 tabular-nums">{u.count}×</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
