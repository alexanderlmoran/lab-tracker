"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ToolbarSelect } from "./ToolbarSelect";

export type LabsTab = "patients" | "labs" | "tracking" | "phlebotomy" | "calendar";

// `calendar` is intentionally not its own dropdown entry — it's a sub-view of
// Phlebotomy reached via the Board/Calendar toggle, so the dropdown shows
// "Phlebotomy" for both (see the value mapping below).
const TABS: Array<{ key: LabsTab; label: string }> = [
  { key: "labs", label: "Labs" },
  { key: "patients", label: "Patients" },
  { key: "tracking", label: "Tracking" },
  { key: "phlebotomy", label: "Phlebotomy" },
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
    }
    // Free-text q / lab / test filters apply only to the By-lab board — clear them
    // when focusing a single patient or switching to the phlebotomy / calendar views.
    if (next === "patients" || next === "phlebotomy" || next === "calendar") {
      params.delete("q");
      params.delete("lab");
      params.delete("test");
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/labs?${qs}` : "/labs");
    });
  }

  // Collapsed into a single dropdown (was a 3-button pill group) to keep the
  // whole toolbar on one row — shares the ToolbarSelect look with every other
  // toolbar dropdown.
  return (
    <ToolbarSelect
      ariaLabel="View"
      // Calendar is a Phlebotomy sub-view, so the dropdown reads "Phlebotomy"
      // for both — the Board/Calendar toggle distinguishes them.
      value={tab === "calendar" ? "phlebotomy" : tab}
      options={TABS.map((t) => ({ value: t.key, label: t.label }))}
      onChange={(v) => select(v as LabsTab)}
    />
  );
}
