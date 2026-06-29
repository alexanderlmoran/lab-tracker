"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { SINCE_PRESETS, type SinceKey } from "./time-range";
import { ToolbarSelect } from "./ToolbarSelect";

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
    <ToolbarSelect
      ariaLabel="Time range"
      active={since !== "all"}
      value={since}
      options={SINCE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
      onChange={(v) => select(v as SinceKey)}
    />
  );
}
