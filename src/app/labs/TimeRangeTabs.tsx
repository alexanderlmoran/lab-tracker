"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { SINCE_PRESETS, type SinceKey } from "./time-range";

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
    <select
      aria-label="Time range"
      value={since}
      onChange={(e) => select(e.target.value as SinceKey)}
      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 focus:border-zinc-500 focus:outline-none"
    >
      {SINCE_PRESETS.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
