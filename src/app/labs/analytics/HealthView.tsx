// Health sub-tab — one status card per category so you can glance and see
// whether every part of the pipeline is running. All signals come from
// existing tables (scraper status, job queue, email logs, inbound, tracking).

import type { SystemHealth, HealthStatus, HealthItem } from "./data";

const DOT: Record<HealthStatus, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
  idle: "bg-zinc-300",
};

const STATUS_TEXT: Record<HealthStatus, string> = {
  green: "Healthy",
  yellow: "Attention",
  red: "Problem",
  idle: "Idle",
};

const STATUS_BADGE: Record<HealthStatus, string> = {
  green: "bg-emerald-50 text-emerald-700",
  yellow: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  idle: "bg-zinc-100 text-zinc-500",
};

function ItemRow({ item }: { item: HealthItem }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[item.status]}`} />
      <span className="text-zinc-700">{item.label}</span>
      {item.note ? (
        <span className="ml-auto truncate pl-2 text-xs text-zinc-500">
          {item.note}
        </span>
      ) : null}
    </div>
  );
}

export function HealthView({ health }: { health: SystemHealth }) {
  const problems = health.categories.filter((c) => c.status === "red").length;
  const attention = health.categories.filter((c) => c.status === "yellow").length;
  const overall: HealthStatus =
    problems > 0 ? "red" : attention > 0 ? "yellow" : "green";

  return (
    <div className="space-y-5">
      <div
        className={`flex flex-wrap items-center gap-3 rounded-lg border p-4 ${
          overall === "green"
            ? "border-emerald-200 bg-emerald-50"
            : overall === "yellow"
              ? "border-amber-200 bg-amber-50"
              : "border-red-200 bg-red-50"
        }`}
      >
        <span className={`h-3 w-3 rounded-full ${DOT[overall]}`} />
        <span className="text-sm font-semibold text-zinc-900">
          {overall === "green"
            ? "All systems running"
            : overall === "yellow"
              ? `${attention} need${attention === 1 ? "s" : ""} attention`
              : `${problems} problem${problems === 1 ? "" : "s"} to fix`}
        </span>
        <span className="ml-auto text-xs text-zinc-500">
          {health.categories.length} categories monitored
        </span>
      </div>

      <section className="grid gap-3 md:grid-cols-2">
        {health.categories.map((c) => (
          <div
            key={c.key}
            className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${DOT[c.status]}`} />
              <h3 className="text-sm font-semibold text-zinc-900">{c.label}</h3>
              <span
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[c.status]}`}
              >
                {STATUS_TEXT[c.status]}
              </span>
            </div>
            <p className="text-sm tabular-nums text-zinc-800">{c.headline}</p>
            {c.detail ? (
              <p className="text-xs text-zinc-500">{c.detail}</p>
            ) : null}
            {c.items && c.items.length > 0 ? (
              <div className="space-y-1.5 border-t border-zinc-100 pt-3">
                {c.items.map((item) => (
                  <ItemRow key={item.label} item={item} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
