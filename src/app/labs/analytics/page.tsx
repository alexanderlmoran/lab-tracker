import { requireRole } from "@/lib/auth-guard";
import { HudPulse } from "../HudPulse";
import { AnalyticsTabs } from "./AnalyticsTabs";
import { ReportsView } from "./ReportsView";
import { RevenueView } from "./RevenueView";
import { TeamView } from "./TeamView";
import { HealthView } from "./HealthView";
import { EngineView } from "./EngineView";
import { getTeamActivity, getSystemHealth, getEngineMetrics, getRevenueData, type AnalyticsTab } from "./data";

export const dynamic = "force-dynamic";

const SUBTITLE: Record<AnalyticsTab, string> = {
  reports: "Snapshot of all-time data.",
  revenue: "Sell-price revenue, volume, and rough margin by lab + month.",
  engine: "Is the automation accurate? PDF correctness + posting.",
  team: "Who did what, and how much — per person.",
  health: "Is every part of the pipeline running?",
};

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // admin + developer (developer outranks admin); staff is redirected.
  const user = await requireRole("admin");
  const sp = await searchParams;

  const rawTab = typeof sp.tab === "string" ? sp.tab : "reports";
  const tab: AnalyticsTab =
    rawTab === "team" || rawTab === "health" || rawTab === "engine" || rawTab === "revenue"
      ? rawTab
      : "reports";

  const parsedWindow =
    typeof sp.window === "string" ? Number.parseInt(sp.window, 10) : 7;
  const windowDays = Number.isFinite(parsedWindow) ? parsedWindow : 7;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl space-y-5 px-6 py-4 pb-16">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-900">
              Analytics
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500">{SUBTITLE[tab]}</p>
          </div>
          <AnalyticsTabs tab={tab} />
        </div>

        {tab === "reports" ? <ReportsView /> : null}
        {tab === "revenue" ? <RevenueView data={await getRevenueData()} /> : null}
        {tab === "engine" ? (
          <EngineView metrics={await getEngineMetrics()} />
        ) : null}
        {tab === "team" ? (
          <TeamView activity={await getTeamActivity(windowDays)} />
        ) : null}
        {tab === "health" ? (
          <HealthView health={await getSystemHealth()} />
        ) : null}
      </main>
    </div>
  );
}
