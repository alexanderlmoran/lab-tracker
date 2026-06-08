"use client";

import { useRef, useState, useTransition } from "react";
import { specForLab } from "@/lib/req-forms/specs";
import type { ReqFormData } from "@/lib/req-forms/types";
import { prepareReqForm, generateReqForm } from "./req-form-actions";

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
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

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
    });
  }
  function close() {
    dialogRef.current?.close();
    setOpen(false);
  }
  function set(key: keyof ReqFormData, v: string) {
    setFields((f) => ({ ...f, [key]: v }));
  }
  function generate() {
    setErr(null);
    start(async () => {
      const r = await generateReqForm(caseId, fields);
      if (!r.ok) return setErr(r.error);
      // base64 → blob → open in a new tab for review/print
      const bin = atob(r.pdfBase64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      window.open(url, "_blank");
    });
  }

  // show only fields that have a resolved value OR are commonly editable
  const shown = FIELDS.filter((f) => f.key in fields || ["dob", "sex", "collectionDate", "orderNumber"].includes(f.key as string));

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

      <dialog ref={dialogRef} className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40">
        {open ? (
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-900">{label || "Requisition form"}</h2>
              <button type="button" onClick={close} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100">×</button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
              <p className="mb-2 text-[11px] text-zinc-500">Review & complete, then generate. Blank/missing fields are highlighted — fill any you can.</p>
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
              {err ? <p className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[12px] text-rose-700">{err}</p> : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3">
              <button type="button" onClick={close} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">Close</button>
              <button type="button" onClick={generate} disabled={pending} className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {pending ? "Working…" : "Generate & open"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
