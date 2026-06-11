"use client";

import { useRef, useState } from "react";
import { CHIP, RailChip } from "./card-counts";
import { useDismiss } from "./use-dismiss";

/**
 * Small toolbar popover that documents the card chip catalog grouped by
 * category. Source of truth for what each color means — eliminates the
 * "what does orange mean again?" tax once cards get colorful.
 *
 * KEEP IN SYNC with badgeTier() in LabKanbanBoard.tsx — the "which columns
 * show what" note at the bottom mirrors that policy.
 */
export function LabsLegend() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

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
        <div className="absolute right-0 z-20 mt-1 max-h-[75vh] w-80 overflow-y-auto rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg">
          <Section title="Action — click the card">
            <Row
              chip={
                <RailChip className="border-amber-400 bg-amber-100 font-semibold text-amber-800">
                  review
                </RailChip>
              }
              desc="Result PDF staged — open to Approve → PracticeBetter"
            />
          </Section>

          <Section title="Escalation — needs attention">
            <Row chip={<RailChip className={CHIP.caution}>📞 1</RailChip>} desc="1 contact attempt since last reached" />
            <Row chip={<RailChip className={CHIP.warn}>📞 2</RailChip>} desc="2 attempts — escalate" />
            <Row chip={<RailChip className={CHIP.alert}>📞 3+</RailChip>} desc="3+ attempts — intervene" />
            <Row chip={<RailChip className={CHIP.caution}>5d</RailChip>} desc="No step progress in N days" />
            <Row chip={<RailChip className={CHIP.alert}>overdue 3d</RailChip>} desc="Result expected date has passed" />
            <Row chip={<RailChip className={CHIP.caution}>due today</RailChip>} desc="Result due now / within 2 days" />
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
            <Row
              chip={<span className="text-[10px] text-emerald-600">📦 ABC123</span>}
              desc="FedEx pickup booked (confirmation #)"
            />
          </Section>

          <Section title="Merge & duplicates">
            <Row
              chip={
                <span className="rounded bg-purple-200 px-1.5 text-[10px] font-semibold text-purple-800">
                  merged ×2
                </span>
              }
              desc="One physical order's cards collapsed (By accession view); card tinted purple"
            />
            <Row
              chip={
                <span className="rounded bg-purple-200 px-1.5 text-[10px] font-semibold text-purple-800">
                  3 labs
                </span>
              }
              desc="A patient's cards collapsed within the lane (By patient / By date views)"
            />
            <Row
              chip={
                <RailChip className="border-purple-300 bg-purple-50 text-purple-700">
                  dup ×2
                </RailChip>
              }
              desc="Same patient + accession on separate cards — merge or dismiss the extras"
            />
          </Section>

          <Section title="Info — just a count">
            <Row chip={<RailChip className={CHIP.info}>✉️ 2</RailChip>} desc="Emails sent on this case" />
            <Row
              chip={
                <span className="inline-flex h-[17px] min-w-[19px] items-center justify-center rounded-full bg-sky-100 px-1.5 text-[10px] font-bold text-sky-800">
                  38
                </span>
              }
              desc="Column count — lives in the accent dot by each title"
            />
          </Section>

          <p className="mt-2 border-t border-slate-200 pt-2 text-[10.5px] leading-snug text-slate-500">
            Card background tint mirrors the contact-attempt scale
            (yellow → orange → red for 1 / 2 / 3+ open attempts), or
            turns blue when <strong>ready?</strong> triggers.
          </p>
          <p className="mt-2 border-t border-slate-200 pt-2 text-[10.5px] leading-snug text-slate-500">
            <strong>Chips by column:</strong> TO DO → Pending Upload show
            everything; <strong>Complete Uploaded</strong> and{" "}
            <strong>ROF Scheduled</strong> show only ✉️ / 📞 (who still needs
            contact); <strong>ROF Done, Protocol received, Completed</strong>{" "}
            show none. Tracking # / expected window / ACC# also hide from
            Complete Uploaded onward — including on merged cards.
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
