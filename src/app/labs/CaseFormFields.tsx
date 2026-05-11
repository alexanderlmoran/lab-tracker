"use client";

import { useRef, useState } from "react";
import type { LabCase } from "@/lib/types";
import { LabCombobox } from "./LabCombobox";
import { PatientPicker } from "./PatientPicker";
import { BarcodeScanner } from "./BarcodeScanner";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

export function CaseFormFields({ initial }: { initial?: LabCase | null }) {
  const v = initial ?? null;
  const trackingRef = useRef<HTMLInputElement | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  function onScan(code: string) {
    if (trackingRef.current) {
      trackingRef.current.value = code;
      // Surface the change to any listeners (the form is otherwise uncontrolled).
      trackingRef.current.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
    }
    setScannerOpen(false);
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Patient
        </h3>
      </div>

      <PatientPicker initial={initial} />

      <div className="sm:col-span-2">
        <label htmlFor="patientAddress" className={labelClass}>
          Address
        </label>
        <textarea
          id="patientAddress"
          name="patientAddress"
          rows={2}
          maxLength={500}
          defaultValue={v?.patient_address ?? ""}
          className={inputClass}
        />
      </div>

      <div className="sm:col-span-2 mt-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Case
        </h3>
      </div>

      <div className="sm:col-span-2">
        <LabCombobox initial={initial} />
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="trackingNumber" className={labelClass}>
          Tracking number
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="trackingNumber"
            name="trackingNumber"
            ref={trackingRef}
            maxLength={100}
            defaultValue={v?.tracking_number ?? ""}
            className={`${inputClass} mt-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            title="Scan barcode"
            aria-label="Scan barcode"
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Scan
          </button>
        </div>
        {scannerOpen ? (
          <BarcodeScanner
            onClose={() => setScannerOpen(false)}
            onDetect={onScan}
          />
        ) : null}
      </div>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            name="partialExpected"
            defaultChecked={v?.partial_expected ?? false}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Partial results expected
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            name="autoSendEmails"
            defaultChecked={v?.auto_send_emails ?? true}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Auto-open email confirmation on step toggle
        </label>
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="notes" className={labelClass}>
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={v?.notes ?? ""}
          className={inputClass}
        />
      </div>
    </div>
  );
}
