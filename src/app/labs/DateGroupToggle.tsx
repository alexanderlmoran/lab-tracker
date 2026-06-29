"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Toggle the by-collection-date section headers across ALL board columns. On by
 * default; ?dates=off renders the columns as flat lists. URL-driven so the board
 * reads the same param. Lives in the toolbar between the Merge menu and search.
 */
export function DateGroupToggle() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const off = searchParams.get("dates") === "off";

  function toggle() {
    const params = new URLSearchParams(searchParams.toString());
    if (off) params.delete("dates");
    else params.set("dates", "off");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `/labs?${qs}` : "/labs"));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
        off
          ? "border-zinc-300 bg-white text-zinc-400 line-through hover:bg-zinc-50"
          : "border-orange-300 bg-orange-50 text-orange-800"
      }`}
      title="Group every column into date sections by collection date — click to hide"
    >
      Group by date
    </button>
  );
}
