"use client";

import { useRef, useState } from "react";
import { useDismiss } from "./use-dismiss";

export type ToolbarOption = {
  value: string;
  label: string;
  /** Optional per-option tooltip (used by the Merge menu). */
  title?: string;
};

/**
 * Shared "classy black" toolbar dropdown — a button + popover modeled on the
 * Merge menu. ONE source of truth for the toolbar dropdown look, so View, Lab,
 * Test, Time and Merge all match. Replaces the native <select>s, which can't be
 * fully restyled (arrow + option list) consistently across browsers.
 */
export function ToolbarSelect({
  value,
  options,
  onChange,
  ariaLabel,
  prefix,
  title,
  active = false,
  buttonClassName = "",
}: {
  value: string;
  options: ToolbarOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Static lead-in shown before the current label, e.g. "Merge". */
  prefix?: string;
  /** Tooltip for the trigger button. */
  title?: string;
  /** When the dropdown is narrowing/collapsing (non-default value), an amber
   *  ring keeps that visible at a glance even though every trigger is black. */
  active?: boolean;
  /** Extra classes on the trigger (e.g. a max-width cap). */
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, open, () => setOpen(false));

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md border bg-zinc-900 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-800 ${
          active ? "border-amber-400 ring-1 ring-amber-400" : "border-zinc-700"
        } ${buttonClassName}`}
      >
        <span className="truncate">
          {prefix ? `${prefix}: ` : ""}
          {current?.label ?? ""}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-400">▾</span>
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-max min-w-full max-w-[16rem] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-0.5 text-xs shadow-lg"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              title={o.title}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
              className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left ${
                o.value === value
                  ? "bg-zinc-700 font-medium text-white"
                  : "text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value ? (
                <span className="shrink-0 text-emerald-400">✓</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
