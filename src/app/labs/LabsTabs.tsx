"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type LabsTab = "patients" | "labs" | "tracking";

const TABS: Array<{ key: LabsTab; label: string }> = [
  { key: "labs", label: "By lab" },
  { key: "patients", label: "By patient" },
  { key: "tracking", label: "Tracking" },
];

export function LabsTabs({ tab }: { tab: LabsTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function select(next: LabsTab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    // `labs` is the default — omit from URL to keep it clean.
    if (next === "labs") params.delete("tab");
    else params.set("tab", next);
    // `ready` and `stale` only apply to the By-lab view. If we don't clear
    // them when leaving that tab, the filter silently persists on By-patient
    // (which ignores them), making the two views appear contradictory.
    if (next !== "labs") {
      params.delete("ready");
      params.delete("stale");
    }
    // The patient-focus view picks a patient via its own dropdown; reset
    // the prior selection when toggling tabs so users land on the picker
    // and not on a stale focused patient.
    if (next !== "patients") {
      params.delete("patient");
    } else {
      // Free-text q/lab filters don't apply to single-patient focus.
      params.delete("q");
      params.delete("lab");
    }
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
