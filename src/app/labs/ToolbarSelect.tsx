"use client";

import { useRef, useState } from "react";
import { useDismiss } from "./use-dismiss";
import { toolbarBtn } from "./toolbar-styles";

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
        className={`flex items-center gap-1 ${toolbarBtn(active || open)} ${buttonClassName}`}
      >
        <span className="truncate">
          {prefix ? `${prefix}: ` : ""}
          {current?.label ?? ""}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-500">▾</span>
      </button>
      {open ? (
        // Light CSS — the dark-theme inversion renders this as a dark menu.
        <div
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-max min-w-full max-w-[16rem] overflow-y-auto rounded-md border border-zinc-200 bg-white py-0.5 text-xs text-zinc-700 shadow-lg"
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
                  ? "bg-zinc-100 font-medium text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value ? (
                <span className="shrink-0 text-emerald-600">✓</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
