"use client";

import type { LabCase } from "@/lib/types";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

export function CaseFormFields({ initial }: { initial?: LabCase | null }) {
  const v = initial ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Patient
        </h3>
      </div>

      <div>
        <label htmlFor="patientName" className={labelClass}>
          Name <span className="text-red-600">*</span>
        </label>
        <input
          id="patientName"
          name="patientName"
          required
          maxLength={200}
          defaultValue={v?.patient_name ?? ""}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="patientEmail" className={labelClass}>
          Email <span className="text-red-600">*</span>
        </label>
        <input
          id="patientEmail"
          name="patientEmail"
          type="email"
          required
          maxLength={200}
          defaultValue={v?.patient_email ?? ""}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="patientPhone" className={labelClass}>
          Phone
        </label>
        <input
          id="patientPhone"
          name="patientPhone"
          type="tel"
          maxLength={40}
          defaultValue={v?.patient_phone ?? ""}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="patientDob" className={labelClass}>
          DOB
        </label>
        <input
          id="patientDob"
          name="patientDob"
          type="date"
          defaultValue={v?.patient_dob ?? ""}
          className={inputClass}
        />
      </div>

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

      <div>
        <label htmlFor="labName" className={labelClass}>
          Lab name <span className="text-red-600">*</span>
        </label>
        <input
          id="labName"
          name="labName"
          required
          maxLength={100}
          placeholder="e.g. Dutch, Genova, Vibrant"
          defaultValue={v?.lab_name ?? ""}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="labPanel" className={labelClass}>
          Panel
        </label>
        <input
          id="labPanel"
          name="labPanel"
          maxLength={100}
          placeholder="e.g. Complete, Adrenal"
          defaultValue={v?.lab_panel ?? ""}
          className={inputClass}
        />
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="trackingNumber" className={labelClass}>
          Tracking number
        </label>
        <input
          id="trackingNumber"
          name="trackingNumber"
          maxLength={100}
          defaultValue={v?.tracking_number ?? ""}
          className={inputClass}
        />
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
