"use client";

import { useRef, useState, useTransition } from "react";
import { specForLab } from "@/lib/req-forms/specs";
import type { ReqFormData } from "@/lib/req-forms/types";
import { prepareReqForm, generateReqForm } from "./req-form-actions";
import { ReqFormCalibrator } from "./ReqFormCalibrator";

// Editable fields shown in the dialog, in order. label + which forms care is
// handled by just showing all and letting the spec stamp what it positions.
const FIELDS: Array<{ key: keyof ReqFormData; label: string }> = [
  { key: "patientName", label: "Patient name" },
  { key: "lastName", label: "Last name" },
  { key: "firstName", label: "First name" },
  { key: "mi", label: "MI" },
  { key: "dob", label: "DOB (MM/DD/YYYY)" },
  { key: "sex", label: "Sex (M/F)" },
  { key: "collectionDate", label: "Collection date" },
  { key: "orderDate", label: "Order date" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "orderNumber", label: "Order / Sample #" },
];

export function ReqFormButton({ caseId, labName }: { caseId: string; labName: string | null }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [fields, setFields] = useState<ReqFormData>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [editableKeys, setEditableKeys] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("req-form.pdf");
  const [calibrate, setCalibrate] = useState(false);
  const [custom, setCustom] = useState<Array<{ key: string; label: string }>>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // Only render the button if this lab has a req-form template.
  if (!specForLab(labName)) return null;

  function openDialog() {
    setErr(null);
    setOpen(true);
    queueMicrotask(() => dialogRef.current?.showModal());
    start(async () => {
      const r = await prepareReqForm(caseId);
      if (!r.ok) return setErr(r.error);
      setFields(r.fields);
      setMissing(r.missing);
      setLabel(r.label);
      setEditableKeys(r.editableKeys);
      setCustom(r.custom);
    });
  }
  function close() {
    dialogRef.current?.close();
    setOpen(false);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(null);
    setCalibrate(false);
  }
  function set(key: keyof ReqFormData, v: string) {
    setFields((f) => ({ ...f, [key]: v }));
  }
  // Returning from the calibrator: refresh the custom-field list (new fields may
  // have been added) without clobbering the values already typed.
  function exitCalibrate() {
    setCalibrate(false);
    start(async () => {
      const r = await prepareReqForm(caseId);
      if (r.ok) setCustom(r.custom);
    });
  }
  function generate() {
    setErr(null);
    start(async () => {
      const r = await generateReqForm(caseId, fields, customValues);
      if (!r.ok) return setErr(r.error);
      // base64 → blob → embedded preview (like the PDF review modal)
      const bin = atob(r.pdfBase64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(new Blob([buf], { type: "application/pdf" })));
      setFilename(r.filename);
    });
  }

  // show only the form's variable fields (the rest is fixed: clinic address,
  // clinic phone, labs@ email, fasting Yes — all applied automatically).
  const labelFor = (k: string) => FIELDS.find((f) => f.key === k)?.label ?? k;
  const shown = editableKeys.map((k) => ({ key: k as keyof ReqFormData, label: labelFor(k) }));

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        title="Auto-fill this lab's requisition form"
      >
        Print req form
      </button>

      <dialog ref={dialogRef} className={`w-full ${calibrate ? "max-w-4xl" : pdfUrl ? "max-w-3xl" : "max-w-md"} rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40`}>
        {open && calibrate ? (
          <ReqFormCalibrator
            caseId={caseId}
            values={fields as Record<string, string | undefined>}
            customVals={customValues}
            onBack={exitCalibrate}
          />
        ) : open ? (
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-900">{label || "Requisition form"}</h2>
              <button type="button" onClick={close} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100">×</button>
            </div>
            {pdfUrl ? (
              <>
                {/* key forces a fresh iframe each render — Chrome's embedded PDF
                    viewer won't reliably reload when src swaps to a new blob URL. */}
                <iframe key={pdfUrl} src={pdfUrl} title="Requisition preview" className="h-[72vh] w-full border-0 bg-zinc-100" />
                <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3">
                  <button type="button" onClick={() => setPdfUrl(null)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">← Back to edit</button>
                  <div className="flex gap-2">
                    <a href={pdfUrl} download={filename} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">Download</a>
                    <button type="button" onClick={() => window.open(pdfUrl, "_blank")} className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Open / Print</button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
                  <p className="mb-2 text-[11px] text-zinc-500">Only the variables below — clinic address/phone, labs@centnerhb.com, and Fasting=Yes are filled automatically. Amber = needs you (e.g. DOB). Entered DOB saves back to the tracker.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {shown.map((f) => (
                      <label key={f.key} className="flex flex-col gap-0.5 text-[11px] text-zinc-600">
                        {f.label}
                        <input
                          value={(fields[f.key] as string) ?? ""}
                          onChange={(e) => set(f.key, e.target.value)}
                          className={`rounded border px-2 py-1 text-[13px] text-zinc-900 ${
                            missing.includes(f.key as string) && !(fields[f.key])
                              ? "border-amber-400 bg-amber-50"
                              : "border-zinc-300 bg-white"
                          }`}
                        />
                      </label>
                    ))}
                  </div>
                  {custom.length ? (
                    <div className="mt-3 border-t border-zinc-200 pt-2">
                      <p className="mb-1 text-[11px] font-medium text-emerald-700">Your added fields</p>
                      <div className="grid grid-cols-2 gap-2">
                        {custom.map((cf) => (
                          <label key={cf.key} className="flex flex-col gap-0.5 text-[11px] text-zinc-600">
                            {cf.label}
                            <input
                              value={customValues[cf.key] ?? ""}
                              onChange={(e) => setCustomValues((v) => ({ ...v, [cf.key]: e.target.value }))}
                              className="rounded border border-emerald-300 bg-emerald-50/40 px-2 py-1 text-[13px] text-zinc-900"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {err ? <p className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[12px] text-rose-700">{err}</p> : null}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3">
                  <button type="button" onClick={() => setCalibrate(true)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50" title="Drag fields to position them on the form">⤢ Calibrate positions</button>
                  <div className="flex gap-2">
                    <button type="button" onClick={close} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">Close</button>
                    <button type="button" onClick={generate} disabled={pending} className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                      {pending ? "Working…" : "Generate preview"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
