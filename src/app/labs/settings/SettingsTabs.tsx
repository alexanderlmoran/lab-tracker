"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { SETTINGS_TABS, type SettingsTab } from "./tab";

export function SettingsTabs({
  tab,
  isAdmin = true,
}: {
  tab: SettingsTab;
  /** When false (staff users), only the General tab is rendered. */
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const visibleTabs = isAdmin
    ? SETTINGS_TABS
    : SETTINGS_TABS.filter((t) => t.key === "general");

  function select(next: SettingsTab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "general") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs/settings?${qs}` : "/labs/settings");
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      className="inline-flex flex-wrap gap-1 rounded-md border border-zinc-200 bg-white p-1"
    >
      {visibleTabs.map((t) => {
        const active = t.key === tab;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => select(t.key)}
            className={`rounded-[5px] px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
