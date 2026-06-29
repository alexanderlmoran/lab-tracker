"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import { carrierForCase } from "@/lib/labs/carrier";
import { awaitingPickup } from "@/lib/labs/pickup";
import { formatPersonName } from "@/lib/format";
import { scheduleFedexPickup } from "./tracking-actions";

// Board-level "Schedule pickup" — books ONE FedEx pickup (one API call per
// Book click) from the clinic for the day's outbound lab samples and STAMPS
// the confirmation onto the cards you include, so each card is traceable to
// the pickup. Carrier-aware: Cyrex/UPS cards are surfaced separately (FedEx
// pickup can't cover them) until a UPS pickup integration exists. Candidates
// come from awaitingPickup() — cards whose package hasn't been scanned into
// the carrier network yet, NOT every card with a tracking # (which once made
// the count balloon to all unstamped history).
export function SchedulePickupButton({ cases }: { cases: LabCase[] }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [date, setDate] = useState("");
  const [carrier, setCarrier] = useState<"FDXE" | "FDXG">("FDXE");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const { fedex, ups } = useMemo(() => {
    const ready = cases.filter(awaitingPickup);
    return {
      fedex: ready.filter((c) => carrierForCase(c) === "fedex"),
      ups: ready.filter((c) => carrierForCase(c) === "ups"),
    };
  }, [cases]);

  function openDialog() {
    setResult(null);
    setDate(new Date().toLocaleDateString("en-CA")); // today, YYYY-MM-DD
    setSelected(new Set(fedex.map((c) => c.id))); // default: all FedEx cards
    setOpen(true);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function close() {
    dialogRef.current?.close();
    setOpen(false);
  }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function book() {
    // One booking per dialog open — after a success the Book button locks so a
    // second click can't dispatch a second FedEx truck. Reopen to book again.
    if (result?.ok) return;
    if (!date) return setResult({ ok: false, msg: "Pick a ready date." });
    if (selected.size === 0) return setResult({ ok: false, msg: "Select at least one card to include." });
    setResult(null);
    const caseIds = [...selected];
    start(async () => {
      const r = await scheduleFedexPickup({ readyDate: date, packageCount: caseIds.length, carrierCode: carrier, caseIds });
      if (!r.ok) return setResult({ ok: false, msg: r.error ?? "Pickup failed" });
      setResult({ ok: true, msg: `Booked — confirmation ${r.data?.confirmationNumber} · stamped ${r.data?.stamped ?? 0} card(s)` });
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        title="Book a FedEx pickup from the clinic for today's samples"
      >
        Schedule pickup{fedex.length ? ` (${fedex.length})` : ""}
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {open ? (
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-900">Schedule FedEx pickup</h2>
              <button type="button" onClick={close} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100">
                ×
              </button>
            </div>
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1 text-[12px] text-zinc-600">
                  Ready date
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-[12px] text-zinc-600">
                  Service
                  <select
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value as "FDXE" | "FDXG")}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
                  >
                    <option value="FDXE">Express</option>
                    <option value="FDXG">Ground</option>
                  </select>
                </label>
              </div>

              {/* FedEx cards to include */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[12px] text-zinc-600">
                  <span>Cards in this pickup ({selected.size}/{fedex.length})</span>
                  {fedex.length > 0 ? (
                    <button
                      type="button"
                      className="text-[11px] text-indigo-600 hover:underline"
                      onClick={() => setSelected(selected.size === fedex.length ? new Set() : new Set(fedex.map((c) => c.id)))}
                    >
                      {selected.size === fedex.length ? "Clear all" : "Select all"}
                    </button>
                  ) : null}
                </div>
                {fedex.length === 0 ? (
                  <p className="rounded border border-zinc-200 bg-zinc-50 px-2 py-2 text-[12px] text-zinc-500">
                    No FedEx cards with a tracking # are waiting for a pickup.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded border border-zinc-200 divide-y divide-zinc-100">
                    {fedex.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[12px] hover:bg-zinc-50">
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="shrink-0" />
                        <span className="truncate font-medium text-zinc-800">{formatPersonName(c.patient_name)}</span>
                        <span className="truncate text-zinc-500">{c.lab_name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">{c.tracking_number}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* UPS / Cyrex — not coverable by a FedEx pickup yet */}
              {ups.length > 0 ? (
                <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-700">
                  {ups.length} UPS card{ups.length === 1 ? "" : "s"} (Cyrex) need a separate UPS pickup — schedule those manually for now.
                </p>
              ) : null}

              {result ? (
                <p
                  className={`rounded-md border px-2 py-1.5 text-[12px] ${
                    result.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}
                >
                  {result.msg}
                </p>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3">
              <button type="button" onClick={close} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                Close
              </button>
              <button
                type="button"
                onClick={book}
                disabled={pending || selected.size === 0 || result?.ok === true}
                className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {pending ? "Booking…" : result?.ok ? "Booked ✓" : `Book pickup (${selected.size})`}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
