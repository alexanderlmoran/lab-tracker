"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { LabCatalogEntry } from "@/lib/labs/catalog";
import { LAB_CATALOG, PEPTIDES_OFFERED, findLabByName } from "@/lib/labs/catalog";
import { PatientPicker } from "./PatientPicker";
import { BarcodeScanner } from "./BarcodeScanner";
import { normalizeScannedTracking } from "@/lib/tracking/normalize";
import { listEffectiveLabsForPicker } from "./actions";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-[11px] font-medium text-zinc-700";

type LabRowState = {
  /** Free-text label the user typed/picked. May be "<name> · <panel>" or
   * just a bare provider name. The submit-time helper splits this into
   * labName + labPanel for the server action. */
  display: string;
  /** Only used when display resolves to "Peptides"; rides into labPanel on
   * submit so the peptide name appears in patient-facing emails. */
  peptide: string;
  collectionDate: string;
  trackingNumber: string;
  /** Lab portal accession # — populated by scraper auto-match if blank,
   * or manually entered here to short-circuit the matching cascade. */
  labExternalRef: string;
  pickupConfirmation: string;
  partialExpected: boolean;
};

export type LabRowPayload = {
  labName: string;
  labPanel: string | null;
  collectionDate: string | null;
  trackingNumber: string | null;
  labExternalRef: string | null;
  pickupConfirmation: string | null;
  partialExpected: boolean;
};

function emptyRow(): LabRowState {
  return {
    display: "",
    peptide: "",
    collectionDate: "",
    trackingNumber: "",
    labExternalRef: "",
    pickupConfirmation: "",
    partialExpected: false,
  };
}

function isPeptidesRow(display: string): boolean {
  const match = findLabByName(display.trim());
  return match?.provider === "Peptides";
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
  // Peptides rows: the peptide-name input rides on lab_panel so it appears
  // verbatim in patient-facing emails ("Peptides — BPC-157").
  if (match?.provider === "Peptides") {
    const peptide = row.peptide.trim();
    if (peptide) labPanel = peptide;
  }
  return {
    labName,
    labPanel,
    collectionDate: row.collectionDate || null,
    trackingNumber: row.trackingNumber.trim() || null,
    labExternalRef: row.labExternalRef.trim() || null,
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
  const [scannerOpenIdx, setScannerOpenIdx] = useState<number | null>(null);
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
    () =>
      effective
        .filter((e) => !e.retired)
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b)),
    [effective],
  );

  const peptidesDatalistId = `${datalistId}-peptides`;

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
        <datalist id={peptidesDatalistId}>
          {PEPTIDES_OFFERED.map((p) => (
            <option key={p} value={p} />
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

                {isPeptidesRow(row.display) ? (
                  <div className="sm:col-span-2">
                    <label className={labelClass}>
                      Peptide
                      <span className="text-red-600"> *</span>
                      <span className="ml-2 text-[10px] font-normal text-zinc-400">
                        appears in patient emails — pick or type custom
                      </span>
                    </label>
                    <input
                      type="text"
                      list={peptidesDatalistId}
                      value={row.peptide}
                      onChange={(e) =>
                        updateRow(i, { peptide: e.target.value })
                      }
                      placeholder="e.g. BPC-157"
                      maxLength={120}
                      className={`${inputClass} mt-1`}
                    />
                  </div>
                ) : null}

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
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={row.trackingNumber}
                      onChange={(e) =>
                        updateRow(i, { trackingNumber: e.target.value })
                      }
                      maxLength={100}
                      className={`${inputClass} flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => setScannerOpenIdx(i)}
                      title="Scan barcode"
                      aria-label="Scan barcode"
                      className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Scan
                    </button>
                  </div>
                  {scannerOpenIdx === i ? (
                    <BarcodeScanner
                      onClose={() => setScannerOpenIdx(null)}
                      onDetect={(code) => {
                        updateRow(i, {
                          trackingNumber: normalizeScannedTracking(code),
                        });
                        setScannerOpenIdx(null);
                      }}
                    />
                  ) : null}
                </div>

                <div>
                  <label className={labelClass}>Accession #</label>
                  <input
                    type="text"
                    value={row.labExternalRef}
                    onChange={(e) =>
                      updateRow(i, { labExternalRef: e.target.value })
                    }
                    maxLength={64}
                    placeholder="e.g. 007143558"
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
