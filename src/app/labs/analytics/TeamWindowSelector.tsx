"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

const WINDOWS: Array<{ days: number; label: string }> = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

export function TeamWindowSelector({ windowDays }: { windowDays: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(days: number) {
    if (days === windowDays) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "team");
    // 7d is the default — keep it out of the URL.
    if (days === 7) params.delete("window");
    else params.set("window", String(days));
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs/analytics?${qs}` : "/labs/analytics");
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Time window"
      className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.days}
          type="button"
          role="tab"
          aria-selected={w.days === windowDays}
          onClick={() => select(w.days)}
          className={`rounded-[5px] px-3 py-1 text-xs font-medium transition-colors ${
            w.days === windowDays
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
