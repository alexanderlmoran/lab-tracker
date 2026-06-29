"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ToolbarSelect } from "./ToolbarSelect";

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
    <ToolbarSelect
      ariaLabel="Lab filter"
      active={!!lab}
      value={lab}
      options={[
        { value: "", label: "All labs" },
        ...labNames.map((name) => ({ value: name, label: name })),
      ]}
      onChange={onChange}
    />
  );
}
