"use client";

import { useRef, useState } from "react";
import type { LabCase } from "@/lib/types";
import type { LabCatalogEntry } from "@/lib/labs/catalog";
import { LabCombobox } from "./LabCombobox";
import { PatientPicker } from "./PatientPicker";
import { BarcodeScanner } from "./BarcodeScanner";
import { normalizeScannedTracking } from "@/lib/tracking/normalize";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

export function CaseFormFields({ initial }: { initial?: LabCase | null }) {
  const v = initial ?? null;
  const trackingRef = useRef<HTMLInputElement | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  // "Partial expected" is auto-toggled to match the selected lab's catalog
  // default — currently only Access Blood Panel ships with this on. Editing
  // an existing case keeps the row's own value; new cases follow the lab
  // catalog default after a pick. The user can always override manually.
  const [partialExpected, setPartialExpected] = useState<boolean>(
    v?.partial_expected ?? false,
  );

  function onLabSelected(entry: LabCatalogEntry | null) {
    if (entry && typeof entry.partialExpected === "boolean") {
      setPartialExpected(entry.partialExpected);
    }
  }

  function onScan(code: string) {
    const tracking = normalizeScannedTracking(code);
    if (trackingRef.current) {
      trackingRef.current.value = tracking;
      trackingRef.current.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
    }
    setScannerOpen(false);
  }

  return (
    <div className="space-y-6">
      {/* ── Patient ──────────────────────────────────────────── */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Patient
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* DOB is editable here (edit-only form) and saves to the patient
              record — all their cases + patients_seed (#23). */}
          <PatientPicker initial={initial} editableDob />
        </div>
      </section>

      {/* ── Case ──────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Case
        </h3>
        <div className="space-y-4">
          <LabCombobox initial={initial} onSelectionChange={onLabSelected} />

          <div>
            <label htmlFor="collectionDate" className={labelClass}>
              Collection date
            </label>
            <input
              id="collectionDate"
              name="collectionDate"
              type="date"
              defaultValue={v?.collection_date ?? ""}
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              When the sample was drawn. Anchors the expected-results estimate.{" "}
              <span className="text-zinc-400">CSV column: “Date Shipped”.</span>
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="trackingNumber" className={labelClass}>
                Tracking number{" "}
                <span className="font-normal text-zinc-400">
                  (CSV: “Tracking Number”)
                </span>
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

            <div>
              <label htmlFor="labExternalRef" className={labelClass}>
                Accession #{" "}
                <span className="font-normal text-zinc-400">
                  (lab&apos;s order/result ID; auto-populated by scraper)
                </span>
              </label>
              <input
                id="labExternalRef"
                name="labExternalRef"
                maxLength={64}
                defaultValue={v?.lab_external_ref ?? ""}
                className={`${inputClass} mt-1`}
                placeholder="e.g. 007143558"
              />
            </div>

            <div>
              <label htmlFor="pickupConfirmation" className={labelClass}>
                Pickup confirmation #{" "}
                <span className="font-normal text-zinc-400">
                  (CSV: “Confirmation Number”)
                </span>
              </label>
              <input
                id="pickupConfirmation"
                name="pickupConfirmation"
                maxLength={100}
                defaultValue={v?.pickup_confirmation ?? ""}
                placeholder="Carrier pickup code (optional)"
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                name="partialExpected"
                checked={partialExpected}
                onChange={(e) => setPartialExpected(e.target.checked)}
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
        </div>
      </section>

      {/* ── Notes ─────────────────────────────────────────────── */}
      <section>
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
      </section>

      {/* Phone / address stay out of the form per UX decision 2026-05-12 —
          fields remain in the DB for existing rows and patient identity
          matching. Hidden inputs in PatientPicker carry forward whatever the
          picker pre-loaded so edits don't clear them. (DOB is now editable
          above on this edit form — #23.) */}
      <input type="hidden" name="patientAddress" value={v?.patient_address ?? ""} readOnly />
    </div>
  );
}
