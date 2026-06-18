"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * "All labs" lab-name filter — URL-driven (?lab=). Split out of SearchBar so it
 * can sit in the toolbar to the right of the search box and left of the time
 * range, instead of wrapping underneath the search input.
 */
export function LabFilterSelect({ labNames }: { labNames: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const lab = searchParams.get("lab") ?? "";

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("lab", value);
    else params.delete("lab");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `/labs?${qs}` : "/labs"));
  }

  return (
    <select
      value={lab}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Lab filter"
      className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 focus:border-zinc-500 focus:outline-none"
    >
      <option value="">All labs</option>
      {labNames.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
