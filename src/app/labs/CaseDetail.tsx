"use client";

import { useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  columnLabelForWorkflow,
  completedStepCount,
  getCaseWorkflow,
  getColumnFor,
  getWorkflowColumns,
  getWorkflowSteps,
} from "@/lib/columns";
import { StepChecklist } from "./StepChecklist";
import { ActivityLog } from "./ActivityLog";
import { BarcodeScanner } from "./BarcodeScanner";
import { CaseDialog } from "./CaseDialog";
import { LabPortalLinks } from "./LabPortalLinks";
import { RefreshLabStatusButton } from "./RefreshLabStatusButton";
import { RefreshTrackingButton } from "./RefreshTrackingButton";
import { attachTrackingFromScan, markCaseClosed } from "./actions";
import { getLabDestination, trackingDestinationWarning } from "@/lib/labs/catalog";
// PracticeBetter integration removed 2026-05-12 — was abandoned 2026-05-11
// per the project memo. Staff now upload results to PB manually if needed.

function MarkClosedButton({
  caseId,
  isAlreadyClosed,
  isPeptides,
}: {
  caseId: string;
  isAlreadyClosed: boolean;
  isPeptides: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirmText = isPeptides
    ? "Mark this peptides order as received?\n\nTicks both shipping and receipt steps so the card lands in the Received column. No patient emails fire — use this for orders the patient has already confirmed.\n\nReversible: untick any step to undo."
    : "Mark this case as closed?\n\nSets every applicable step to done and lands the card in the Closed column. No patient emails fire — use this for cases that are historically complete.\n\nReversible: untick any step in the checklist to undo.";
  const doneLabel = isPeptides ? "Received" : "Protocol received";
  const actionLabel = isPeptides ? "Mark as received →" : "Mark protocol received →";

  function onClick() {
    if (!confirm(confirmText)) return;
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
        title={
          isAlreadyClosed
            ? `${doneLabel} already`
            : isPeptides
            ? "Mark the peptides order as received without firing emails"
            : "Bulk-advance to Protocol received without firing emails"
        }
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Saving…" : isAlreadyClosed ? doneLabel : actionLabel}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </div>
  );
}

function ScanKitButton({
  caseId,
  hasTracking,
  step1Done,
}: {
  caseId: string;
  hasTracking: boolean;
  step1Done: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onDetect(code: string) {
    setOpen(false);
    setMsg(null);
    start(async () => {
      const r = await attachTrackingFromScan({
        caseId,
        trackingNumber: code,
      });
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      const bits: string[] = [];
      if (r.data?.trackingChanged) bits.push(`TRK ${code} attached`);
      if (r.data?.advancedStep1) bits.push("step 1 marked");
      setMsg(bits.length > 0 ? bits.join(" · ") : "No changes (already on file)");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        title={
          step1Done && hasTracking
            ? "Re-scan to attach a new tracking number"
            : "Scan to attach tracking and advance Step 1"
        }
      >
        Scan kit
      </button>
      {msg ? (
        <span className="text-[11px] text-emerald-700">{msg}</span>
      ) : null}
      {open ? (
        <BarcodeScanner
          title="Scan kit barcode"
          onClose={() => setOpen(false)}
          onDetect={onDetect}
        />
      ) : null}
    </>
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
  const workflow = getCaseWorkflow(row);
  const workflowColumns = getWorkflowColumns(workflow);
  const totalSteps = getWorkflowSteps(workflow).length;
  const destination = getLabDestination(row.lab_name, row.lab_panel);
  const destWarning = trackingDestinationWarning({
    labName: row.lab_name,
    labPanel: row.lab_panel,
    trackingStatus: row.tracking_status,
    trackingLocation: row.tracking_location,
  });

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
          <Field
            label="DOB"
            value={
              row.patient_dob ? `${row.patient_dob}${ageFromDob(row.patient_dob)}` : null
            }
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Case
        </h3>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500">
              Lab
            </span>
            <span className="text-zinc-900">
              {row.lab_panel ? `${row.lab_name} · ${row.lab_panel}` : row.lab_name}
            </span>
            <LabPortalLinks labName={row.lab_name} />
          </div>
          <Field
            label="Ships to"
            value={
              destination
                ? `${destination.city}${destination.state ? `, ${destination.state}` : ""}`
                : null
            }
          />
          {destWarning ? (
            <div className="flex items-start gap-2 py-1">
              <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500" />
              <p className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
                ⚠ {destWarning}
              </p>
            </div>
          ) : null}
          <Field label="Collected" value={row.collection_date} />
          <div className="flex items-center gap-2 py-1">
            <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500">
              Tracking
            </span>
            <span className="text-zinc-900">{row.tracking_number || "—"}</span>
            <ScanKitButton
              caseId={row.id}
              hasTracking={Boolean(row.tracking_number)}
              step1Done={Boolean(row.step1_sample_sent)}
            />
          </div>
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
        <div
          className="grid overflow-hidden rounded-md border border-zinc-200 text-center text-[11px] font-medium"
          style={{ gridTemplateColumns: `repeat(${workflowColumns.length}, minmax(0, 1fr))` }}
        >
          {workflowColumns.map((col) => {
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
                {columnLabelForWorkflow(workflow, col)}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          {done} of {totalSteps} steps complete · column derived from highest completed step
        </p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Steps
          </h3>
          <MarkClosedButton
            caseId={row.id}
            isAlreadyClosed={currentCol === "closed"}
            isPeptides={workflow === "peptides"}
          />
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
