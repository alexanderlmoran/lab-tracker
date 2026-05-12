"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type LabsTab = "patients" | "labs" | "tracking";

const TABS: Array<{ key: LabsTab; label: string }> = [
  { key: "patients", label: "By patient" },
  { key: "labs", label: "By lab" },
  { key: "tracking", label: "Tracking" },
];

export function LabsTabs({ tab }: { tab: LabsTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(next: LabsTab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    // `patients` is the default — omit from URL to keep it clean.
    if (next === "patients") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs?${qs}` : "/labs");
    });
  }

  return (
    <div
      role="tablist"
      aria-label="View"
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
