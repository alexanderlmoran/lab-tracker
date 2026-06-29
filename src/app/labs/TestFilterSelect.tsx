"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ToolbarSelect } from "./ToolbarSelect";

/**
 * "All tests" test/panel filter — URL-driven (?test=). Sits in the toolbar to
 * the right of the lab filter. The free-text search box ALSO matches test names
 * (e.g. "eboo waste"); this dropdown is the pick-from-a-list shortcut for a
 * specific panel. Options come from listDistinctPanels(); the value sent here is
 * matched in listLabCases via the same testGroupLabel()/normalizeTestKey() key,
 * so the option and the cases it represents can't disagree.
 */
export function TestFilterSelect({ panels }: { panels: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const test = searchParams.get("test") ?? "";

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("test", value);
    else params.delete("test");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `/labs?${qs}` : "/labs"));
  }

  return (
    <ToolbarSelect
      ariaLabel="Test filter"
      active={!!test}
      value={test}
      options={[
        { value: "", label: "All tests" },
        ...panels.map((name) => ({ value: name, label: name })),
      ]}
      onChange={onChange}
      buttonClassName="max-w-[9rem]"
    />
  );
}
