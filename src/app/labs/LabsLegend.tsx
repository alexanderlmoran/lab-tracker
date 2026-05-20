"use client";

import { useEffect, useRef, useState } from "react";
import { CHIP, RailChip } from "./card-counts";

/**
 * Small toolbar popover that documents the card chip catalog grouped by
 * category. Source of truth for what each color means — eliminates the
 * "what does orange mean again?" tax once cards get colorful.
 */
export function LabsLegend() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
      >
        ℹ️ Legend
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg">
          <Section title="Escalation — needs attention">
            <Row chip={<RailChip className={CHIP.caution}>📞 1</RailChip>} desc="1 contact attempt since last reached" />
            <Row chip={<RailChip className={CHIP.warn}>📞 2</RailChip>} desc="2 attempts — escalate" />
            <Row chip={<RailChip className={CHIP.alert}>📞 3+</RailChip>} desc="3+ attempts — intervene" />
            <Row chip={<RailChip className={CHIP.caution}>5d</RailChip>} desc="No step progress in N days" />
            <Row chip={<RailChip className={CHIP.alert}>overdue</RailChip>} desc="Result expected date has passed" />
            <Row chip={<RailChip className={CHIP.caution}>due</RailChip>} desc="Result due soon" />
            <Row chip={<RailChip className={CHIP.warn}>wrong city?</RailChip>} desc="Tracking destination mismatches lab city" />
          </Section>

          <Section title="State — where it stands">
            <Row chip={<RailChip className={CHIP.state}>ready?</RailChip>} desc="Delivered + past expected — check lab portal" />
            <Row chip={<RailChip className={CHIP.info}>Pre-transit</RailChip>} desc="Label created, not yet picked up" />
            <Row chip={<RailChip className={CHIP.state}>In transit</RailChip>} desc="On its way to the lab" />
            <Row chip={<RailChip className={CHIP.stateStrong}>Out for delivery</RailChip>} desc="Final-mile delivery today" />
            <Row chip={<RailChip className={CHIP.good}>Delivered</RailChip>} desc="Arrived at the lab" />
            <Row chip={<RailChip className={CHIP.alert}>Exception</RailChip>} desc="Shipping problem — check carrier" />
            <Row chip={<RailChip className={CHIP.alert}>Returned</RailChip>} desc="Package returned to sender" />
            <Row chip={<RailChip className={CHIP.muted}>Unknown</RailChip>} desc="Carrier hasn't reported status" />
          </Section>

          <Section title="Info — just a count">
            <Row chip={<RailChip className={CHIP.info}>✉️ 2</RailChip>} desc="Emails sent on this case" />
          </Section>

          <p className="mt-2 border-t border-slate-200 pt-2 text-[10.5px] leading-snug text-slate-500">
            Card background tint mirrors the contact-attempt scale
            (yellow → orange → red for 1 / 2 / 3+ open attempts), or
            turns blue when <strong>ready?</strong> triggers.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h4>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Row({ chip, desc }: { chip: React.ReactNode; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0">{chip}</span>
      <span className="text-[11px] leading-tight text-slate-700">{desc}</span>
    </div>
  );
}
