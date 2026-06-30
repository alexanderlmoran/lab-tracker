"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { toolbarBtn } from "./toolbar-styles";

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
        className={toolbarBtn(probablyReadyOnly)}
        title="Show only cases whose results are likely available now"
      >
        Likely ready
      </button>
      <button
        type="button"
        onClick={() => toggle("stale", staleOnly)}
        className={toolbarBtn(staleOnly)}
        title="Show only cases with no progress in a while"
      >
        Stale only
      </button>
    </div>
  );
}
