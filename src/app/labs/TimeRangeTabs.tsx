"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { SINCE_PRESETS, type SinceKey } from "./time-range";

const PRESETS = SINCE_PRESETS;

export function TimeRangeTabs({ since }: { since: SinceKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(next: SinceKey) {
    if (next === since) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("since");
    else params.set("since", next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs?${qs}` : "/labs");
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Time range"
      className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5"
    >
      {PRESETS.map((p) => {
        const active = p.key === since;
        return (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => select(p.key)}
            className={`rounded-[5px] px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
