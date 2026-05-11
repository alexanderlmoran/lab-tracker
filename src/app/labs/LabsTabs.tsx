"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type LabsTab = "patients" | "labs";

export function LabsTabs({ tab }: { tab: LabsTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(next: LabsTab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
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
      <TabButton
        active={tab === "patients"}
        onClick={() => select("patients")}
        label="By patient"
      />
      <TabButton
        active={tab === "labs"}
        onClick={() => select("labs")}
        label="By lab"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-[5px] px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-zinc-900 text-white"
          : "text-zinc-600 hover:bg-zinc-100"
      }`}
    >
      {label}
    </button>
  );
}
