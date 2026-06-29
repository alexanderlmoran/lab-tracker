"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ToolbarSelect } from "./ToolbarSelect";

// Merge-view state shared with LabKanbanBoard: the menu (toolbar, left of the
// search bar) WRITES ?merge= + localStorage; the board only READS. The URL
// param wins so the two can never disagree; the stored value covers
// param-less visits (the board comes back the way you left it).
export const MERGE_STORAGE_KEY = "labKanbanMergeMode";
export type MergeMode = "off" | "dupes" | "patient" | "date";
export function isMergeMode(v: unknown): v is MergeMode {
  return v === "off" || v === "dupes" || v === "patient" || v === "date";
}

export const MERGE_LABEL: Record<MergeMode, string> = {
  off: "Off",
  dupes: "By accession",
  patient: "By patient",
  date: "By date",
};

const OPTIONS: Array<{ mode: MergeMode; title: string }> = [
  { mode: "dupes", title: "Collapse a same-accession order (Vibrant Zoomer panels) into one card across columns." },
  { mode: "patient", title: "Collapse each patient's cards within a column into one card." },
  { mode: "date", title: "Collapse each patient's cards within a column by collection date." },
  { mode: "off", title: "Every card renders separately." },
];

export function MergeViewMenu() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const param = searchParams.get("merge");
  const [stored, setStored] = useState<MergeMode>("dupes");
  useEffect(() => {
    try {
      const m = window.localStorage.getItem(MERGE_STORAGE_KEY);
      if (isMergeMode(m)) setStored(m);
    } catch {
      // storage unavailable — default stands
    }
  }, []);
  const mode: MergeMode = isMergeMode(param) ? param : stored;

  function pick(next: MergeMode) {
    setStored(next);
    try {
      window.localStorage.setItem(MERGE_STORAGE_KEY, next);
    } catch {
      // storage unavailable — the URL param still applies
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("merge", next);
    router.replace(`/labs?${params.toString()}`);
  }

  return (
    <ToolbarSelect
      ariaLabel="Merge view"
      prefix="Merge"
      title="How cards collapse together on the board"
      active={mode !== "off"}
      value={mode}
      options={OPTIONS.map((o) => ({
        value: o.mode,
        label: MERGE_LABEL[o.mode],
        title: o.title,
      }))}
      onChange={(v) => pick(v as MergeMode)}
    />
  );
}
