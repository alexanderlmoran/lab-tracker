"use client";

import { useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import { COLUMN_LABEL, COLUMN_ORDER, completedStepCount, getColumnFor } from "@/lib/columns";
import { StepChecklist } from "./StepChecklist";
import { ActivityLog } from "./ActivityLog";
import { CaseDialog } from "./CaseDialog";
import { RefreshLabStatusButton } from "./RefreshLabStatusButton";
import { RefreshTrackingButton } from "./RefreshTrackingButton";
import { markCaseClosed } from "./actions";
import {
  dumpPracticeBetterNotesForCase,
  linkCaseToPracticeBetterRecord,
  probePracticeBetterWriteEndpoints,
  pushLabToPracticeBetter,
} from "./practicebetter-actions";

function MarkClosedButton({ caseId, isAlreadyClosed }: { caseId: string; isAlreadyClosed: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (
      !confirm(
        "Mark this case as closed?\n\nSets every applicable step to done and lands the card in the Closed column. No patient emails fire — use this for cases that are historically complete.\n\nReversible: untick any step in the checklist to undo.",
      )
    )
      return;
    setError(null);
    start(async () => {
      const r = await markCaseClosed(caseId);
      if (!r.ok) setError(r.error ?? "Failed");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || isAlreadyClosed}
        title={isAlreadyClosed ? "Already closed" : "Bulk-advance to Closed without firing emails"}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Closing…" : isAlreadyClosed ? "Closed" : "Mark as closed →"}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

function PracticeBetterLinkRow({ row }: { row: LabCase }) {
  const [pending, start] = useTransition();
  const [val, setVal] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  function onLink() {
    const recordId = val.trim();
    if (!recordId) return;
    setStatus(null);
    start(async () => {
      const r = await linkCaseToPracticeBetterRecord({ caseId: row.id, recordId });
      if (!r.ok) {
        setStatus(`Error: ${r.error}`);
        return;
      }
      const d = r.data!;
      setStatus(
        `Linked to ${d.name ?? "(no name)"}${d.email ? ` <${d.email}>` : ""}.`,
      );
      setVal("");
    });
  }

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2">
        <span className="w-24 text-xs uppercase tracking-wide text-zinc-500">
          PB record
        </span>
        {row.practicebetter_record_id ? (
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">
            {row.practicebetter_record_id}
          </code>
        ) : (
          <span className="text-xs text-zinc-500">Not linked</span>
        )}
      </div>
      <div className="flex items-center gap-2 pl-[6.5rem]">
        <input
          type="text"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Paste PB record ID"
          className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs"
          disabled={pending}
        />
        <button
          type="button"
          onClick={onLink}
          disabled={pending || !val.trim()}
          className="rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
        >
          {pending ? "Linking…" : "Link"}
        </button>
      </div>
      {status ? (
        <p className="pl-[6.5rem] text-xs text-zinc-600">{status}</p>
      ) : null}
    </div>
  );
}

function PracticeBetterPushButton({ row }: { row: LabCase }) {
  const [pending, start] = useTransition();
  const [dumpOutput, setDumpOutput] = useState<string | null>(null);
  function onClick() {
    start(async () => {
      const r = await pushLabToPracticeBetter({
        caseId: row.id,
        kind: "manual",
        force: true,
      });
      if (!r.ok) {
        alert(`PracticeBetter push failed: ${r.error}`);
        return;
      }
      const d = r.data;
      const methodInfo = d?.writeMethod
        ? ` (verified via ${d.writeMethod} ${d.writeStatus})`
        : "";
      if (d?.skippedReason) {
        alert(`Skipped: ${d.skippedReason} (record ${d.recordId || "—"})`);
      } else if (d?.createdNewRecord) {
        alert(
          `Created new PB client record ${d.recordId} for ${row.patient_email} and pushed lab note${methodInfo}.`,
        );
      } else {
        alert(`Pushed to PB record ${d?.recordId}${methodInfo}.`);
      }
    });
  }
  function onDump() {
    setDumpOutput("Loading…");
    start(async () => {
      const r = await dumpPracticeBetterNotesForCase({ caseId: row.id });
      if (!r.ok) {
        setDumpOutput(`Error: ${r.error}`);
        return;
      }
      const d = r.data!;
      setDumpOutput(
        `record_id: ${d.recordId}\nprofile keys: ${d.profileKeys.join(", ")}\n\n--- profile.notes (${(d.notes ?? "").length} chars) ---\n${d.notes ?? "(empty)"}`,
      );
    });
  }
  function onProbeWrites() {
    setDumpOutput("Probing PB write endpoints…");
    start(async () => {
      const r = await probePracticeBetterWriteEndpoints({ caseId: row.id });
      if (!r.ok) {
        setDumpOutput(`Error: ${r.error}`);
        return;
      }
      const d = r.data!;
      setDumpOutput(
        `POST /consultant/labrequests → ${d.labRequest.status}\n${d.labRequest.body}\n\nPOST /consultant/sessionnotes → ${d.sessionNote.status}\n${d.sessionNote.body}`,
      );
    });
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          title={
            row.practicebetter_record_id
              ? `Linked to PB record ${row.practicebetter_record_id}`
              : "Looks up PB client by patient email and appends a lab note."
          }
          className="rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send to PracticeBetter"}
        </button>
        <button
          type="button"
          onClick={onDump}
          disabled={pending}
          title="GET the linked PB record and show its profile.notes content."
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Show PB notes
        </button>
        <button
          type="button"
          onClick={onProbeWrites}
          disabled={pending}
          title="Try POST /consultant/labrequests and POST /consultant/sessionnotes to see which writes PB allows."
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Probe PB writes
        </button>
      </div>
      {dumpOutput ? (
        <pre className="max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-[11px] leading-snug text-zinc-800 whitespace-pre-wrap">
          {dumpOutput}
        </pre>
      ) : null}
    </div>
  );
}

function ageFromDob(dob: string | null): string {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return ` (age ${age})`;
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="text-zinc-900">{value || "—"}</span>
    </div>
  );
}

export function CaseDetail({ row }: { row: LabCase }) {
  const currentCol = getColumnFor(row);
  const done = completedStepCount(row);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Patient
          </h3>
          <CaseDialog
            mode="edit"
            initial={row}
            triggerLabel="Edit"
            triggerClassName="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
          />
        </div>
        <div className="space-y-1.5">
          <Field label="Email" value={row.patient_email} />
          <Field label="Phone" value={row.patient_phone} />
          <Field
            label="DOB"
            value={
              row.patient_dob ? `${row.patient_dob}${ageFromDob(row.patient_dob)}` : null
            }
          />
          <Field label="Address" value={row.patient_address} />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Case
        </h3>
        <div className="space-y-1.5">
          <Field
            label="Lab"
            value={row.lab_panel ? `${row.lab_name} · ${row.lab_panel}` : row.lab_name}
          />
          <Field label="Tracking" value={row.tracking_number} />
          {row.tracking_number ? (
            <div className="flex items-start gap-2 py-1">
              <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500">
                Carrier
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                {row.tracking_status ? (
                  <p className="text-xs text-zinc-700">
                    <strong className="capitalize">{row.tracking_status.replace(/_/g, " ")}</strong>
                    {row.tracking_location ? ` · ${row.tracking_location}` : ""}
                    {row.tracking_status_detail ? ` — ${row.tracking_status_detail}` : ""}
                    {row.tracking_polled_at ? (
                      <span className="ml-2 text-[10px] text-zinc-400">
                        polled {row.tracking_polled_at.slice(0, 16).replace("T", " ")}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <RefreshTrackingButton caseId={row.id} />
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-2 py-1">
            <span className="w-24 text-xs uppercase tracking-wide text-zinc-500">
              Lab API
            </span>
            <RefreshLabStatusButton caseId={row.id} />
          </div>
          <div className="flex items-center gap-2 py-1">
            <span className="w-24 text-xs uppercase tracking-wide text-zinc-500">
              PB push
            </span>
            <PracticeBetterPushButton row={row} />
          </div>
          <PracticeBetterLinkRow row={row} />
          <Field
            label="Partial?"
            value={row.partial_expected ? "Yes (steps 2 + 3 active)" : "No"}
          />
          <Field
            label="Auto-send"
            value={row.auto_send_emails ? "On" : "Off"}
          />
          <Field label="Notes" value={row.notes} />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Process
        </h3>
        <div className="grid grid-cols-7 overflow-hidden rounded-md border border-zinc-200 text-center text-[11px] font-medium">
          {COLUMN_ORDER.map((col) => {
            const active = col === currentCol;
            return (
              <div
                key={col}
                className={`px-2 py-2 ${
                  active
                    ? "bg-zinc-900 text-white"
                    : "bg-zinc-50 text-zinc-600"
                }`}
              >
                {COLUMN_LABEL[col]}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          {done} of 9 steps complete · column derived from highest completed step
        </p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Steps
          </h3>
          <MarkClosedButton caseId={row.id} isAlreadyClosed={currentCol === "closed"} />
        </div>
        <StepChecklist initial={row} />
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Activity
        </h3>
        <ActivityLog caseId={row.id} />
      </section>
    </div>
  );
}
