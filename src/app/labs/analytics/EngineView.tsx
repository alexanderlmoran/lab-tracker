// Engine sub-tab — "is the automation accurate?" Staged-PDF accuracy, how
// completed labs reached the chart, PB upload reliability, the live review
// queue, and an 8-week approve-vs-wrong trend. All from existing tables.

import type { EngineMetrics } from "./data";

function pct(n: number | null): string {
  return n == null ? "—" : `${n}%`;
}

// Tone the headline % by how good it is (accuracy/reliability metrics).
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
  const { pdf, posting, upload, queue, trend } = metrics;
  const trendMax = Math.max(1, ...trend.map((t) => t.approved + t.wrong));

  return (
    <div className="space-y-5">
      {/* Headline accuracy cards */}
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

      <p className="text-xs text-zinc-400">
        From the audit trail (lab_case_audit / lab_events / pb_upload_jobs). Live PB-coverage % and
        per-reconcile-cycle history are a follow-up (a metrics table the worker writes each cycle).
      </p>
    </div>
  );
}