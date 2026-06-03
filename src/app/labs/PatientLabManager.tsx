"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LabCase } from "@/lib/types";
import { COLUMN_LABEL, getColumnFor } from "@/lib/columns";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import { LabCombobox } from "./LabCombobox";
import { bulkSetStepCompleted, bulkUpdatePatientCases, createLabCases } from "./actions";
import { probeCaseResult } from "./probe-actions";

// Editable view of one existing case. We keep the originals alongside so Save
// only writes the fields the operator actually changed (matches updateLabCase).
type RowEdit = {
  caseId: string;
  labLabel: string;
  tracking: string;
  accession: string;
  collection: string;
  origTracking: string;
  origAccession: string;
  origCollection: string;
  column: string;
  step1Done: boolean;
  labName: string;
  probe: { state: "idle" | "loading" | "done"; msg: string | null };
};

// A lab being added to this patient (goes through createLabCases on save).
type NewLab = {
  key: number;
  labName: string;
  labPanel: string | null;
  partialExpected: boolean;
  accession: string;
  noAccession: boolean;
  tracking: string;
  collection: string;
};

const s = (v: string | null | undefined) => v ?? "";

function toRowEdit(c: LabCase): RowEdit {
  return {
    caseId: c.id,
    labLabel: c.lab_panel ? `${c.lab_name} · ${c.lab_panel}` : c.lab_name,
    tracking: s(c.tracking_number),
    accession: s(c.lab_external_ref),
    collection: s(c.collection_date),
    origTracking: s(c.tracking_number),
    origAccession: s(c.lab_external_ref),
    origCollection: s(c.collection_date),
    column: COLUMN_LABEL[getColumnFor(c)],
    step1Done: Boolean(c.step1_sample_sent),
    labName: c.lab_name,
    probe: { state: "idle", msg: null },
  };
}

const inputCls =
  "w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none";

/**
 * "Manage labs" — a per-patient grid for editing tracking #, accession, and
 * collection date across all of a patient's labs at once, stamping one tracking
 * # / collection date across them ("shipped together"), adding more labs without
 * re-typing patient info, and (optionally) marking them all sample-sent — in one
 * Save. Collapses the ~6-clicks-per-card edit loop into a single screen.
 */
export function ManageLabsButton({
  patientName,
  patientEmail,
  cases,
}: {
  patientName: string;
  patientEmail: string;
  cases: LabCase[];
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RowEdit[]>([]);
  const [newLabs, setNewLabs] = useState<NewLab[]>([]);
  const [bulkTracking, setBulkTracking] = useState("");
  const [bulkAccession, setBulkAccession] = useState("");
  const [bulkCollection, setBulkCollection] = useState("");
  const [markSent, setMarkSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const newKey = useRef(1);

  // Seed editable state from the patient's cases each time the dialog opens, so
  // a re-open after a save reflects the refreshed rows (no stale edits linger).
  function openDialog() {
    setRows(cases.map(toRowEdit));
    setNewLabs([]);
    setBulkTracking("");
    setBulkAccession("");
    setBulkCollection("");
    setMarkSent(false);
    setError(null);
    setOpen(true);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function closeDialog() {
    dialogRef.current?.close();
    setOpen(false);
  }
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => setOpen(false);
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  function patchRow(caseId: string, patch: Partial<RowEdit>) {
    setRows((rs) => rs.map((r) => (r.caseId === caseId ? { ...r, ...patch } : r)));
  }

  function applyToAll() {
    const t = bulkTracking.trim();
    const a = bulkAccession.trim();
    const c = bulkCollection.trim();
    if (t) {
      setRows((rs) => rs.map((r) => ({ ...r, tracking: t })));
      setNewLabs((ns) => ns.map((n) => ({ ...n, tracking: t })));
    }
    if (a) {
      // Accession is normally unique per lab — only stamp it across rows when
      // they're sub-panels of one physical test (e.g. Vibrant Zoomer's
      // Nutrient/Foundational/Gut share one kit + accession).
      setRows((rs) => rs.map((r) => ({ ...r, accession: a })));
      setNewLabs((ns) => ns.map((n) => ({ ...n, accession: a, noAccession: false })));
    }
    if (c) {
      setRows((rs) => rs.map((r) => ({ ...r, collection: c })));
      setNewLabs((ns) => ns.map((n) => ({ ...n, collection: c })));
    }
  }

  async function probeRow(r: RowEdit) {
    patchRow(r.caseId, { probe: { state: "loading", msg: null } });
    const res = await probeCaseResult({ caseId: r.caseId });
    if (!res.ok) {
      patchRow(r.caseId, { probe: { state: "done", msg: res.error ?? "Probe failed" } });
      return;
    }
    const hit = (res.data?.found ?? []).find((f) => f.ref);
    if (hit?.ref) {
      patchRow(r.caseId, {
        accession: hit.ref,
        probe: { state: "done", msg: `found ${hit.ref}` },
      });
    } else {
      patchRow(r.caseId, { probe: { state: "done", msg: "not in portal yet" } });
    }
  }

  function addNewLab() {
    setNewLabs((ns) => [
      ...ns,
      {
        key: newKey.current++,
        labName: "",
        labPanel: null,
        partialExpected: false,
        accession: "",
        noAccession: false,
        tracking: bulkTracking.trim(),
        collection: bulkCollection.trim(),
      },
    ]);
  }
  function patchNewLab(key: number, patch: Partial<NewLab>) {
    setNewLabs((ns) => ns.map((n) => (n.key === key ? { ...n, ...patch } : n)));
  }
  function removeNewLab(key: number) {
    setNewLabs((ns) => ns.filter((n) => n.key !== key));
  }

  const fieldUpdates = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.tracking !== r.origTracking ||
            r.accession !== r.origAccession ||
            r.collection !== r.origCollection,
        )
        .map((r) => ({
          caseId: r.caseId,
          trackingNumber: r.tracking,
          accession: r.accession,
          collectionDate: r.collection,
        })),
    [rows],
  );
  const pendingNewLabs = useMemo(() => newLabs.filter((n) => n.labName.trim().length > 0), [newLabs]);
  const sentTargets = useMemo(
    () => (markSent ? rows.filter((r) => !r.step1Done).map((r) => r.caseId) : []),
    [markSent, rows],
  );
  const dirty = fieldUpdates.length > 0 || pendingNewLabs.length > 0 || sentTargets.length > 0;

  function onSaveAll() {
    setError(null);

    // Validate new labs need an accession (or the explicit opt-out), mirroring
    // createLabCases so the error surfaces before the round-trip.
    const missing = pendingNewLabs.find((n) => !n.noAccession && !n.accession.trim());
    if (missing) {
      setError(`Accession # is required for “${missing.labName}”. Enter it, or tick “No accession #”.`);
      return;
    }

    startSave(async () => {
      if (fieldUpdates.length > 0) {
        const r = await bulkUpdatePatientCases({ updates: fieldUpdates });
        if (!r.ok) {
          setError(r.error ?? "Could not save edits");
          return;
        }
      }

      if (pendingNewLabs.length > 0) {
        const fd = new FormData();
        fd.set("patientName", patientName);
        fd.set("patientEmail", patientEmail);
        const ref = cases[0];
        fd.set("patientPhone", s(ref?.patient_phone));
        fd.set("patientDob", s(ref?.patient_dob));
        fd.set("patientAddress", s(ref?.patient_address));
        if (ref?.auto_send_emails) fd.set("autoSendEmails", "on");
        fd.set("notes", "");
        fd.set(
          "labsJson",
          JSON.stringify(
            pendingNewLabs.map((n) => ({
              labName: n.labName.trim(),
              labPanel: n.labPanel,
              trackingNumber: n.tracking.trim() || null,
              labExternalRef: n.accession.trim() || null,
              noAccession: n.noAccession,
              collectionDate: n.collection.trim() || null,
              partialExpected: n.partialExpected,
            })),
          ),
        );
        const r = await createLabCases(fd);
        if (!r.ok) {
          setError(r.error ?? "Could not add labs");
          return;
        }
      }

      if (sentTargets.length > 0) {
        const r = await bulkSetStepCompleted({ caseIds: sentTargets, step: 1, completed: true });
        if (!r.ok) {
          setError(r.error ?? "Could not mark sample-sent");
          return;
        }
      }

      router.refresh();
      closeDialog();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          openDialog();
        }}
        className="shrink-0 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 hover:bg-zinc-50"
        title="Edit tracking / accession / collection across all of this patient's labs"
      >
        Manage labs
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-4xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {open ? (
          <div className="flex max-h-[90dvh] flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">Manage labs — {patientName}</h2>
                <p className="text-[11px] text-zinc-500">
                  {rows.length} lab{rows.length === 1 ? "" : "s"} · {patientEmail}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Close"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4">
              {/* Apply-to-all (shipped together / same draw day) */}
              <div className="mb-3 flex flex-wrap items-end gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                <span className="text-[11px] font-medium text-zinc-600">Apply to all:</span>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Collected</span>
                  <input
                    type="date"
                    value={bulkCollection}
                    onChange={(e) => setBulkCollection(e.target.value)}
                    className={`${inputCls} w-36`}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Tracking #</span>
                  <input
                    type="text"
                    value={bulkTracking}
                    onChange={(e) => setBulkTracking(e.target.value)}
                    placeholder="one # for the whole shipment"
                    className={`${inputCls} w-48`}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Acc# (same test)</span>
                  <input
                    type="text"
                    value={bulkAccession}
                    onChange={(e) => setBulkAccession(e.target.value)}
                    placeholder="shared accession"
                    className={`${inputCls} w-40 font-mono`}
                  />
                </label>
                <button
                  type="button"
                  onClick={applyToAll}
                  className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Apply
                </button>
              </div>

              {/* Existing labs */}
              <div className="overflow-hidden rounded-md border border-zinc-200">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
                      <th className="px-2 py-1.5 font-medium">Lab</th>
                      <th className="px-2 py-1.5 font-medium">Collected</th>
                      <th className="px-2 py-1.5 font-medium">Tracking #</th>
                      <th className="px-2 py-1.5 font-medium">Acc#</th>
                      <th className="px-2 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.caseId} className="border-t border-zinc-100 align-top">
                        <td className="px-2 py-1.5 text-[12px] text-zinc-800">{r.labLabel}</td>
                        <td className="px-2 py-1.5">
                          <input
                            type="date"
                            value={r.collection}
                            onChange={(e) => patchRow(r.caseId, { collection: e.target.value })}
                            className={`${inputCls} w-32`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            value={r.tracking}
                            onChange={(e) => patchRow(r.caseId, { tracking: e.target.value })}
                            className={`${inputCls} w-44`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={r.accession}
                              onChange={(e) => patchRow(r.caseId, { accession: e.target.value })}
                              className={`${inputCls} w-32 font-mono`}
                            />
                            {probeKeyForLab(r.labName) ? (
                              <button
                                type="button"
                                onClick={() => probeRow(r)}
                                disabled={r.probe.state === "loading"}
                                title="Find this result in the portal by patient name"
                                className="shrink-0 rounded border border-indigo-300 bg-white px-1 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                              >
                                {r.probe.state === "loading" ? "…" : "🔍"}
                              </button>
                            ) : null}
                          </div>
                          {r.probe.msg ? (
                            <p className="mt-0.5 text-[10px] text-zinc-500">{r.probe.msg}</p>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-[11px] text-zinc-500">{r.column}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add labs */}
              {newLabs.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  {newLabs.map((n) => (
                    <div
                      key={n.key}
                      className="flex flex-wrap items-end gap-2 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2"
                    >
                      <div className="min-w-[200px] flex-1">
                        <span className="mb-0.5 block text-[10px] text-zinc-500">Lab</span>
                        <LabCombobox
                          onSelectionChange={(entry) =>
                            patchNewLab(n.key, {
                              labName: entry?.provider ?? "",
                              labPanel: entry?.panel ?? null,
                              partialExpected: Boolean(entry?.partialExpected),
                            })
                          }
                        />
                      </div>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Collected</span>
                        <input
                          type="date"
                          value={n.collection}
                          onChange={(e) => patchNewLab(n.key, { collection: e.target.value })}
                          className={`${inputCls} w-32`}
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Tracking #</span>
                        <input
                          type="text"
                          value={n.tracking}
                          onChange={(e) => patchNewLab(n.key, { tracking: e.target.value })}
                          className={`${inputCls} w-40`}
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Acc#</span>
                        <input
                          type="text"
                          value={n.accession}
                          disabled={n.noAccession}
                          onChange={(e) => patchNewLab(n.key, { accession: e.target.value })}
                          className={`${inputCls} w-28 font-mono disabled:bg-zinc-100`}
                        />
                      </label>
                      <label className="flex items-center gap-1 pb-1.5 text-[10px] text-zinc-600">
                        <input
                          type="checkbox"
                          checked={n.noAccession}
                          onChange={(e) => patchNewLab(n.key, { noAccession: e.target.checked })}
                        />
                        No acc#
                      </label>
                      <button
                        type="button"
                        onClick={() => removeNewLab(n.key)}
                        className="pb-1.5 text-[11px] text-rose-600 hover:underline"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                onClick={addNewLab}
                className="mt-3 rounded-md border border-dashed border-zinc-300 bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50"
              >
                + Add lab
              </button>

              <label className="mt-3 flex items-center gap-2 text-[12px] text-zinc-700">
                <input
                  type="checkbox"
                  checked={markSent}
                  onChange={(e) => setMarkSent(e.target.checked)}
                />
                Also mark all as <span className="font-medium">Sample sent</span> (no emails)
              </label>

              {error ? (
                <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button
                type="button"
                onClick={closeDialog}
                disabled={saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveAll}
                disabled={saving || !dirty}
                className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving
                  ? "Saving…"
                  : `Save all${
                      fieldUpdates.length + pendingNewLabs.length + (sentTargets.length ? 1 : 0) > 0
                        ? ` (${fieldUpdates.length + pendingNewLabs.length}${
                            sentTargets.length ? " +sent" : ""
                          })`
                        : ""
                    }`}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
