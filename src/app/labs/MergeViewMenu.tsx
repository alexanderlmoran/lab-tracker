"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDismiss } from "./use-dismiss";

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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismiss(wrapRef, open, () => setOpen(false));

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
    setOpen(false);
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
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="How cards collapse together on the board"
        className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${
          mode !== "off"
            ? "border-purple-300 bg-purple-50 text-purple-800 hover:bg-purple-100"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Merge: {MERGE_LABEL[mode]} ▾
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-zinc-200 bg-white py-0.5 shadow-lg">
          {OPTIONS.map((o) => (
            <button
              key={o.mode}
              type="button"
              onClick={() => pick(o.mode)}
              title={o.title}
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs ${
                mode === o.mode
                  ? "bg-purple-50 font-medium text-purple-800"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span>{MERGE_LABEL[o.mode]}</span>
              {mode === o.mode ? <span>✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
