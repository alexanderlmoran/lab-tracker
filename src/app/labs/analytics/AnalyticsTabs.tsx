"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { AnalyticsTab } from "./data";

const TABS: Array<{ key: AnalyticsTab; label: string }> = [
  { key: "reports", label: "Reports" },
  { key: "team", label: "Team" },
  { key: "health", label: "Health" },
];

export function AnalyticsTabs({ tab }: { tab: AnalyticsTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(next: AnalyticsTab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    // `reports` is the default — omit from the URL to keep it clean.
    if (next === "reports") params.delete("tab");
    else params.set("tab", next);
    // The window selector only applies to the Team tab; clear it on the way out
    // so it doesn't silently linger on the others.
    if (next !== "team") params.delete("window");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs/analytics?${qs}` : "/labs/analytics");
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Analytics view"
      className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5"
    >
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === tab}
          onClick={() => select(t.key)}
          className={`rounded-[5px] px-3 py-1 text-xs font-medium transition-colors ${
            t.key === tab
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
