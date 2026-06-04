"use client";

import { useRef, useState, useTransition } from "react";
import { scheduleFedexPickup } from "./tracking-actions";

// Board-level "Schedule FedEx pickup" — books one carrier pickup from the clinic
// for the day's outbound lab samples via the FedEx Pickup API (no scraping).
// Shows the confirmation number, or a clear "configure these env vars" message
// until the pickup product + account are set up.
export function SchedulePickupButton() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [date, setDate] = useState("");
  const [count, setCount] = useState(1);
  const [carrier, setCarrier] = useState<"FDXE" | "FDXG">("FDXE");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  function openDialog() {
    setResult(null);
    setDate("");
    setCount(1);
    setOpen(true);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function close() {
    dialogRef.current?.close();
    setOpen(false);
  }

  function book() {
    if (!date) {
      setResult({ ok: false, msg: "Pick a ready date." });
      return;
    }
    setResult(null);
    start(async () => {
      const r = await scheduleFedexPickup({ readyDate: date, packageCount: count, carrierCode: carrier });
      if (!r.ok) {
        setResult({ ok: false, msg: r.error ?? "Pickup failed" });
        return;
      }
      setResult({ ok: true, msg: `Booked — confirmation ${r.data?.confirmationNumber}` });
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        title="Book a FedEx pickup from the clinic for today's samples"
      >
        Schedule pickup
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
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
              <label className="flex flex-col gap-1 text-[12px] text-zinc-600">
                Ready date
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="rounded border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
                />
              </label>
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1 text-[12px] text-zinc-600">
                  Packages
                  <input
                    type="number"
                    min={1}
                    value={count}
                    onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
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
                disabled={pending}
                className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {pending ? "Booking…" : "Book pickup"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
