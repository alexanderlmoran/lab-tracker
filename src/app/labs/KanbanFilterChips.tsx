"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * "Likely ready" and "Stale only" filter chips for the By-lab kanban.
 * URL-driven (?ready=1, ?stale=1) so the toolbar can host them while the
 * board reads the same params for its filtering pass.
 */
export function KanbanFilterChips() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const probablyReadyOnly = searchParams.get("ready") === "1";
  const staleOnly = searchParams.get("stale") === "1";

  function toggle(key: "ready" | "stale", isOn: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (isOn) params.delete(key);
    else params.set(key, "1");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs?${qs}` : "/labs");
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => toggle("ready", probablyReadyOnly)}
        className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          probablyReadyOnly
            ? "border-blue-300 bg-blue-50 text-blue-800"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        title="Show only cases whose results are likely available now"
      >
        Likely ready
      </button>
      <button
        type="button"
        onClick={() => toggle("stale", staleOnly)}
        className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          staleOnly
            ? "border-yellow-300 bg-yellow-50 text-yellow-800"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        title="Show only cases with no progress in a while"
      >
        Stale only
      </button>
    </div>
  );
}
