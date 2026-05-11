"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { LabCase } from "@/lib/types";
import {
  LAB_CATALOG,
  findLabByName,
  type LabCatalogEntry,
} from "@/lib/labs/catalog";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

function entryToDisplay(e: LabCatalogEntry): string {
  return e.name;
}

function turnaroundLabel(e: LabCatalogEntry): string | null {
  const { turnaroundDaysMin: min, turnaroundDaysMax: max } = e;
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${min}–${max}d`;
  return `~${(max ?? min)}d`;
}

/**
 * Lab name + panel input backed by the catalog. Behavior:
 *
 *   • Typing filters the dropdown by substring across name/provider/panel.
 *   • Selecting a catalog entry sets hidden `labName` (provider) and
 *     `labPanel` (panel) — the schema's two-column split is preserved so
 *     existing queries / displays continue to work.
 *   • Free-text (no selection) → `labName` = the typed string, `labPanel`
 *     stays null. Falls through to the existing free-text behavior so users
 *     are never blocked when a lab isn't in the catalog yet.
 *
 * Existing rows whose lab_name is a recognized catalog provider get matched
 * back to their entry on mount so the combobox shows the canonical display
 * name; mismatches fall back to displaying whatever raw text is on the row.
 */
export function LabCombobox({ initial }: { initial?: LabCase | null }) {
  const v = initial ?? null;
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Re-hydrate selection: try catalog match on the joined "<provider> <panel>"
  // string. Only consider it selected if both provider AND panel match (or
  // provider matches and entry has null panel).
  const initialEntry = useMemo<LabCatalogEntry | null>(() => {
    if (!v?.lab_name) return null;
    const joined = v.lab_panel ? `${v.lab_name} ${v.lab_panel}` : v.lab_name;
    const m = findLabByName(joined) ?? findLabByName(v.lab_name);
    if (!m) return null;
    if ((m.panel ?? "") !== (v.lab_panel ?? "")) return null;
    return m;
  }, [v]);

  const [display, setDisplay] = useState<string>(() => {
    if (initialEntry) return entryToDisplay(initialEntry);
    if (v?.lab_name) {
      return v.lab_panel ? `${v.lab_name} · ${v.lab_panel}` : v.lab_name;
    }
    return "";
  });
  const [selected, setSelected] = useState<LabCatalogEntry | null>(initialEntry);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  const matches = useMemo<LabCatalogEntry[]>(() => {
    const q = display.trim().toLowerCase();
    if (!q) return LAB_CATALOG.slice(0, 30);
    const scored: { entry: LabCatalogEntry; score: number }[] = [];
    for (const e of LAB_CATALOG) {
      const hay =
        `${e.name} ${e.provider} ${e.panel ?? ""}`.toLowerCase();
      const idx = hay.indexOf(q);
      if (idx >= 0) scored.push({ entry: e, score: idx });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 30).map((s) => s.entry);
  }, [display]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setActiveIdx(-1);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function applySelection(e: LabCatalogEntry) {
    setSelected(e);
    setDisplay(entryToDisplay(e));
    setOpen(false);
    setActiveIdx(-1);
  }

  function onDisplayChange(next: string) {
    setDisplay(next);
    // Typing always invalidates a prior selection — the user may be replacing
    // it with a different lab or with free-text. The submitted hidden inputs
    // are recomputed from `selected` + `display` below.
    setSelected(null);
    setOpen(true);
    setActiveIdx(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) {
      if (e.key === "ArrowDown") {
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      applySelection(matches[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIdx(-1);
    }
  }

  // Hidden submit values: when selected, use the catalog entry's split.
  // When free-text, the visible string becomes lab_name and panel is empty.
  const submitLabName = selected ? selected.provider : display.trim();
  const submitLabPanel = selected ? (selected.panel ?? "") : "";

  return (
    <>
      <div className="relative" ref={containerRef}>
        <label htmlFor="labCombobox" className={labelClass}>
          Lab <span className="text-red-600">*</span>
          <span className="ml-2 text-[10px] font-normal text-zinc-400">
            pick from catalog or type a custom name
          </span>
        </label>
        <input
          id="labCombobox"
          required
          maxLength={200}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            activeIdx >= 0 ? `${listboxId}-opt-${activeIdx}` : undefined
          }
          placeholder="e.g. Vibrant Zoomer - Gut, Cyrex, Genova"
          value={display}
          onChange={(e) => onDisplayChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={inputClass}
        />
        {open && matches.length > 0 ? (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg"
          >
            {matches.map((e, i) => {
              const ta = turnaroundLabel(e);
              return (
                <li
                  key={e.name}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    applySelection(e);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${
                    i === activeIdx ? "bg-zinc-100" : "hover:bg-zinc-50"
                  } ${e.retired ? "text-zinc-400" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-900">
                      {e.name}
                      {e.retired ? (
                        <span className="ml-2 rounded bg-zinc-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                          retired
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {ta ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                      {ta}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <input type="hidden" name="labName" value={submitLabName} readOnly />
      <input type="hidden" name="labPanel" value={submitLabPanel} readOnly />
    </>
  );
}
