// Engine sub-tab — "is the automation accurate?" Live PB-coverage %, staged-PDF
// accuracy, how completed labs reached the chart, PB upload reliability, the live
// review queue, recent reconcile cycles, and an 8-week approve-vs-wrong trend.

import type { EngineMetrics } from "./data";
import { formatAge } from "./data";

function pct(n: number | null): string {
  return n == null ? "—" : `${n}%`;
}

function tone(n: number | null): string {
  if (n == null) return "text-zinc-400";
  if (n >= 95) return "text-emerald-600";
  if (n >= 80) return "text-amber-600";
  return "text-red-600";
}

function StatCard({
  label,
  value,
  valueClass = "text-zinc-900",
  sub,
}: {
  label: string;
  value: string;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</span>
      {sub ? <span className="text-xs text-zinc-500">{sub}</span> : null}
    </div>
  );
}

function Bar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const w = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 text-zinc-600">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums text-zinc-800">
        {value}
        <span className="ml-1 text-xs text-zinc-400">{w}%</span>
      </span>
    </div>
  );
}

export function EngineView({ metrics }: { metrics: EngineMetrics }) {
  const { pdf, posting, upload, queue, trend, coverage, cycles } = metrics;
  const trendMax = Math.max(1, ...trend.map((t) => t.approved + t.wrong));
  const cycleMax = Math.max(1, ...cycles.map((c) => c.autoposted + c.flagged + c.errors));

  return (
    <div className="space-y-5">
      {/* PB coverage banner — the "is everything on the chart?" headline */}
      <section
        className={`flex flex-wrap items-center gap-4 rounded-lg border p-4 ${
          coverage == null
            ? "border-zinc-200 bg-white"
            : (coverage.coveragePct ?? 0) >= 95
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-200 bg-amber-50"
        }`}
      >
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">PB coverage</span>
          <span className={`text-3xl font-semibold tabular-nums ${tone(coverage?.coveragePct ?? null)}`}>
            {pct(coverage?.coveragePct ?? null)}
          </span>
        </div>
        <div className="text-sm text-zinc-600">
          {coverage == null ? (
            <>
              No snapshot yet — the worker writes one each <code>--lab=all</code> reconcile cycle once the
              metrics migration is applied.
            </>
          ) : (
            <>
              <span className="font-medium text-zinc-800">
                {coverage.strong + coverage.likely}/{coverage.total}
              </span>{" "}
              complete labs verified on a PB chart · {coverage.strong} accession-exact ·{" "}
              {coverage.missing + coverage.noMatch} to review
              <span className="ml-2 text-xs text-zinc-400">audited {formatAge(coverage.ranAt) ?? "—"}</span>
            </>
          )}
        </div>
      </section>

      {/* Accuracy stat cards */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Correct PDF rate"
          value={pct(pdf.pctCorrect)}
          valueClass={tone(pdf.pctCorrect)}
          sub={`${pdf.approved} approved · ${pdf.wrongPdf} wrong · of ${pdf.verdicts} reviewed`}
        />
        <StatCard
          label="PB upload success"
          value={pct(upload.pctSuccess)}
          valueClass={tone(upload.pctSuccess)}
          sub={`${upload.succeeded} ok · ${upload.failed} failed · ${upload.inFlight} in flight`}
        />
        <StatCard
          label="Labs posted to chart"
          value={String(posting.total)}
          sub={`${posting.worker + posting.auto} automated · ${posting.manual} manual · ${posting.backfill} backfill`}
        />
        <StatCard
          label="Awaiting review"
          value={String(queue.awaitingReview)}
          valueClass={queue.awaitingReview > 0 ? "text-amber-600" : "text-emerald-600"}
          sub="staged PDFs a human still needs to approve"
        />
      </section>

      {/* Posting attribution */}
      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">How completed labs reached the chart</h3>
          <span className="text-xs text-zinc-500">{posting.total} total</span>
        </div>
        <div className="space-y-2">
          <Bar label="Worker upload" value={posting.worker} total={posting.total} color="bg-emerald-500" />
          <Bar label="Engine auto-post" value={posting.auto} total={posting.total} color="bg-sky-500" />
          <Bar label="Backfill (on PB)" value={posting.backfill} total={posting.total} color="bg-violet-400" />
          <Bar label="Manual (staff)" value={posting.manual} total={posting.total} color="bg-zinc-400" />
        </div>
        <p className="border-t border-zinc-100 pt-3 text-xs text-zinc-500">
          Worker + engine are unattended. Manual = staff marked complete by hand. Backfill = engine
          confirmed the lab was already on PB and advanced silently.
        </p>
      </section>

      {/* Reconcile cycles */}
      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-zinc-900">Reconcile cycles (recent)</h3>
        {cycles.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No cycles recorded yet — each scheduled reconcile run writes one once the metrics migration is
            applied and the worker redeploys.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-1.5" style={{ height: 96 }}>
              {cycles.map((c) => {
                const total = c.autoposted + c.flagged + c.errors;
                const h = Math.round((total / cycleMax) * 80);
                const seg = (v: number) => (total === 0 ? 0 : Math.round((v / total) * h));
                return (
                  <div key={c.ranAt} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className="flex w-full flex-col justify-end"
                      style={{ height: 80 }}
                      title={`${formatAge(c.ranAt) ?? c.ranAt}\nauto-posted ${c.autoposted} · flagged ${c.flagged} · errors ${c.errors} · advanced ${c.advanced}`}
                    >
                      <div className="w-full bg-red-400" style={{ height: seg(c.errors) }} />
                      <div className="w-full bg-amber-400" style={{ height: seg(c.flagged) }} />
                      <div className="w-full rounded-t-sm bg-emerald-500" style={{ height: seg(c.autoposted) }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Auto-posted</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" /> Flagged</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-400" /> Errors</span>
              <span className="ml-auto">{cycles.length} cycles</span>
            </div>
          </>
        )}
      </section>

      {/* Weekly accuracy trend */}
      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-zinc-900">Review outcomes — last 8 weeks</h3>
        <div className="flex items-end gap-2" style={{ height: 96 }}>
          {trend.map((t) => {
            const total = t.approved + t.wrong;
            const h = Math.round((total / trendMax) * 80);
            const wrongH = total === 0 ? 0 : Math.round((t.wrong / total) * h);
            return (
              <div key={t.week} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-col justify-end" style={{ height: 80 }} title={`${t.approved} approved · ${t.wrong} wrong`}>
                  <div className="w-full rounded-t-sm bg-red-400" style={{ height: wrongH }} />
                  <div className="w-full bg-emerald-500" style={{ height: h - wrongH }} />
                </div>
                <span className="text-[9px] text-zinc-400">{t.week.slice(5)}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Approved (correct)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-400" /> Wrong PDF</span>
        </div>
      </section>
    </div>
  );
}
