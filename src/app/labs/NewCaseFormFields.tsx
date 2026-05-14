"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { LabCatalogEntry } from "@/lib/labs/catalog";
import { LAB_CATALOG, findLabByName } from "@/lib/labs/catalog";
import { PatientPicker } from "./PatientPicker";
import { listEffectiveLabsForPicker } from "./actions";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-[11px] font-medium text-zinc-700";

type LabRowState = {
  /** Free-text label the user typed/picked. May be "<name> · <panel>" or
   * just a bare provider name. The submit-time helper splits this into
   * labName + labPanel for the server action. */
  display: string;
  collectionDate: string;
  trackingNumber: string;
  pickupConfirmation: string;
  partialExpected: boolean;
};

export type LabRowPayload = {
  labName: string;
  labPanel: string | null;
  collectionDate: string | null;
  trackingNumber: string | null;
  pickupConfirmation: string | null;
  partialExpected: boolean;
};

function emptyRow(): LabRowState {
  return {
    display: "",
    collectionDate: "",
    trackingNumber: "",
    pickupConfirmation: "",
    partialExpected: false,
  };
}

function rowToPayload(row: LabRowState): LabRowPayload {
  const display = row.display.trim();
  const match = display ? findLabByName(display) : null;
  let labName = display;
  let labPanel: string | null = null;
  if (match) {
    labName = match.provider;
    labPanel = match.panel ?? null;
  }
  return {
    labName,
    labPanel,
    collectionDate: row.collectionDate || null,
    trackingNumber: row.trackingNumber.trim() || null,
    pickupConfirmation: row.pickupConfirmation.trim() || null,
    partialExpected: row.partialExpected,
  };
}

/**
 * Create-mode form: one patient, N labs. Each lab row is a compact line of
 * fields (lab, collection date, tracking, pickup, partial-expected) so an
 * operator can dump in a whole batch from a single requisition without
 * filing N separate cases. Serializes the labs array into a hidden
 * `labsJson` input — server-side, createLabCases parses it and bulk-inserts.
 */
export function NewCaseFormFields() {
  const [rows, setRows] = useState<LabRowState[]>([emptyRow()]);
  const [effective, setEffective] = useState<LabCatalogEntry[]>(LAB_CATALOG);
  const datalistId = useId();

  // DB-backed catalog. Same source as the single-lab combobox so the two
  // entry paths offer the same options.
  useEffect(() => {
    let cancelled = false;
    listEffectiveLabsForPicker()
      .then((catalogRows) => {
        if (cancelled) return;
        setEffective(
          catalogRows.map((r) => ({
            name: r.name,
            provider: r.provider,
            panel: r.panel,
            turnaroundDaysMin: r.turnaroundDaysMin,
            turnaroundDaysMax: r.turnaroundDaysMax,
            retired: r.retired || undefined,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const datalistOptions = useMemo(
    () => effective.filter((e) => !e.retired).map((e) => e.name),
    [effective],
  );

  function updateRow(i: number, patch: Partial<LabRowState>) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      // Auto-set partial-expected from the catalog match, but only once on
      // first selection — otherwise typing/erasing would flicker the toggle.
      if (patch.display !== undefined) {
        const match = findLabByName(patch.display);
        if (match && typeof match.partialExpected === "boolean") {
          next[i].partialExpected = match.partialExpected;
        }
      }
      return next;
    });
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(i: number) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  const labsJson = useMemo(
    () => JSON.stringify(rows.map(rowToPayload).filter((p) => p.labName.length > 0)),
    [rows],
  );

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Patient
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PatientPicker initial={null} />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Labs ({rows.length})
          </h3>
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            + Add another lab
          </button>
        </div>

        <datalist id={datalistId}>
          {datalistOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <div className="space-y-3">
          {rows.map((row, i) => (
            <div
              key={i}
              className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Lab {i + 1}
                </span>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-[11px] text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={labelClass}>
                    Lab name
                    <span className="text-red-600"> *</span>
                    <span className="ml-2 text-[10px] font-normal text-zinc-400">
                      type or pick from catalog
                    </span>
                  </label>
                  <input
                    type="text"
                    list={datalistId}
                    value={row.display}
                    onChange={(e) => updateRow(i, { display: e.target.value })}
                    placeholder="e.g. Access Blood Panel"
                    className={`${inputClass} mt-1`}
                  />
                </div>

                <div>
                  <label className={labelClass}>Collection date</label>
                  <input
                    type="date"
                    value={row.collectionDate}
                    onChange={(e) =>
                      updateRow(i, { collectionDate: e.target.value })
                    }
                    className={`${inputClass} mt-1`}
                  />
                </div>

                <div>
                  <label className={labelClass}>Tracking #</label>
                  <input
                    type="text"
                    value={row.trackingNumber}
                    onChange={(e) =>
                      updateRow(i, { trackingNumber: e.target.value })
                    }
                    maxLength={100}
                    className={`${inputClass} mt-1`}
                  />
                </div>

                <div>
                  <label className={labelClass}>Pickup confirmation #</label>
                  <input
                    type="text"
                    value={row.pickupConfirmation}
                    onChange={(e) =>
                      updateRow(i, { pickupConfirmation: e.target.value })
                    }
                    maxLength={100}
                    className={`${inputClass} mt-1`}
                  />
                </div>

                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-xs text-zinc-700">
                    <input
                      type="checkbox"
                      checked={row.partialExpected}
                      onChange={(e) =>
                        updateRow(i, { partialExpected: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-zinc-300"
                    />
                    Partial results expected
                  </label>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <label htmlFor="notes" className={labelClass}>
          Notes <span className="font-normal text-zinc-400">(applied to every lab)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          className={`${inputClass} mt-1`}
        />
      </section>

      <section>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            name="autoSendEmails"
            defaultChecked
            className="h-4 w-4 rounded border-zinc-300"
          />
          Auto-open email confirmation on step toggle (legacy — patient emails
          now require explicit Send)
        </label>
      </section>

      {/* Hidden payload consumed by createLabCases. */}
      <input type="hidden" name="labsJson" value={labsJson} readOnly />
      <input type="hidden" name="patientAddress" value="" readOnly />
    </div>
  );
}
