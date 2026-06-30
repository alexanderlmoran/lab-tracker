"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActivityLog } from "../ActivityLog";
import { toolbarBtn } from "../toolbar-styles";
import {
  PHLEB_STATUS_LABEL,
  PHLEB_VENDORS,
  formatApptDateTime,
  formatPrice,
  parsePriceToCents,
  summarizeLabs,
  vendorLabel,
  type PhlebVendor,
} from "@/lib/phlebotomy";
import type { PhlebApptRow } from "./actions";
import {
  cancelAppointment,
  confirmAppointment,
  confirmCompleted,
  forwardReq,
  markDrawn,
  removeCaseFromPhlebotomy,
  requestVendor,
  scheduleAppointment,
  setApptNotes,
  setApptPrice,
  setPatientWindow,
} from "./actions";

// ── small display helpers ──────────────────────────────────────────────────
// formatApptDateTime (shared) returns "" for null; these add the drawer's
// display conventions on top.
const fmtDateTime = (iso: string | null) => formatApptDateTime(iso) || "—";
const fmtStamp = (iso: string | null) => formatApptDateTime(iso);
/** ISO → value for <input type="datetime-local"> in clinic time. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

// Reuse the toolbar control look (the single source of truth for the inversion
// theme): light CSS that reads as dark/black controls in dark mode. Never
// hardcode bg-zinc-900/text-white here — it would invert to white-on-white.
const btn = toolbarBtn(false);
const btnPrimary = toolbarBtn(true);
const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none";
const sectionTitle = "text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

function Stamp({ at }: { at: string | null }) {
  if (!at) return null;
  return <span className="ml-1 text-[10px] text-emerald-600">✓ {fmtStamp(at)}</span>;
}

export function PhlebApptDrawer({
  row,
  onClose,
}: {
  row: PhlebApptRow | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // local form state, reseeded whenever a different appointment opens
  const [patientWindow, setPatientWindow_] = useState("");
  const [vendor, setVendor] = useState<PhlebVendor>("draggo");
  const [vendorOther, setVendorOther] = useState("");
  const [apptLocal, setApptLocal] = useState("");
  const [price, setPrice] = useState("");
  const [phleb, setPhleb] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (row && !d.open) d.showModal();
    if (!row && d.open) d.close();
  }, [row]);

  // reseed inputs from the row each time the selected appointment changes
  const rowKey = row?.case_id ?? "";
  useEffect(() => {
    if (!row) return;
    setErr(null);
    setPatientWindow_(row.patient_window ?? "");
    setVendor((row.vendor as PhlebVendor) ?? "draggo");
    setVendorOther(row.vendor_other ?? "");
    setApptLocal(isoToLocalInput(row.appt_at));
    setPrice(row.price_cents != null ? (row.price_cents / 100).toFixed(2) : "");
    setPhleb(row.phlebotomist_name ?? "");
    setNotes(row.notes ?? "");
    setVendorEmail("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKey]);

  if (!row) {
    return <dialog ref={ref} className="hidden" />;
  }

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setErr(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setErr(res.error);
      else router.refresh();
    });
  }

  const caseId = row.case_id;
  const statusLabel = PHLEB_STATUS_LABEL[row.status];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(96vw,560px)] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/30"
    >
      <div className="flex max-h-[88vh] flex-col">
        {/* Header */}
        <header className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{row.patient_name}</div>
            <div className="text-xs text-zinc-500">
              {row.labs.length ? summarizeLabs(row.labs) : "No labs linked"}
              {row.collection_date ? ` · ${row.collection_date}` : ""}
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
            {statusLabel}
          </span>
          <button type="button" onClick={onClose} className="shrink-0 text-zinc-400 hover:text-zinc-700" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {err ? (
            <p className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</p>
          ) : null}
          {row.canceled_at ? (
            <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
              Previous appointment was canceled {fmtStamp(row.canceled_at)} — re-book below.
            </p>
          ) : null}

          {/* 1 · Patient window */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>1 · Patient date window</div>
            <div className="flex gap-1.5">
              <input
                className={input}
                value={patientWindow}
                placeholder="e.g. July 3–7, mornings"
                onChange={(e) => setPatientWindow_(e.target.value)}
              />
              <button type="button" disabled={pending} className={btn} onClick={() => run(() => setPatientWindow(caseId, patientWindow))}>
                Save
              </button>
            </div>
          </section>

          {/* 2 · Vendor */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>2 · Vendor</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <select className={input + " max-w-[150px]"} value={vendor} onChange={(e) => setVendor(e.target.value as PhlebVendor)}>
                {PHLEB_VENDORS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
              {vendor === "other" ? (
                <input
                  className={input + " max-w-[170px]"}
                  value={vendorOther}
                  placeholder="Vendor name"
                  onChange={(e) => setVendorOther(e.target.value)}
                />
              ) : null}
              <button type="button" disabled={pending} className={btnPrimary} onClick={() => run(() => requestVendor(caseId, vendor, vendorOther))}>
                Request draw
              </button>
            </div>
          </section>

          {/* 3 · Schedule */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>3 · Appointment + cost</div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="text-[11px] text-zinc-500">
                Date / time
                <input type="datetime-local" className={input} value={apptLocal} onChange={(e) => setApptLocal(e.target.value)} />
              </label>
              <label className="text-[11px] text-zinc-500">
                Phlebotomist cost
                <input className={input} value={price} placeholder="$0.00" onChange={(e) => setPrice(e.target.value)} />
              </label>
            </div>
            <input className={input} value={phleb} placeholder="Phlebotomist name (optional)" onChange={(e) => setPhleb(e.target.value)} />
            <button
              type="button"
              disabled={pending}
              className={btnPrimary}
              onClick={() =>
                run(() =>
                  scheduleAppointment(caseId, {
                    apptAtIso: apptLocal,
                    priceCents: parsePriceToCents(price),
                    phlebotomistName: phleb,
                  }),
                )
              }
            >
              Set scheduled
            </button>
          </section>

          {/* 4 · Forward req */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>4 · Forward requisition</div>
            <div className="flex gap-1.5">
              <input
                className={input}
                value={vendorEmail}
                placeholder="vendor@email.com"
                onChange={(e) => setVendorEmail(e.target.value)}
              />
              <button type="button" disabled={pending} className={btn} onClick={() => run(() => forwardReq(caseId, vendorEmail))}>
                Send
              </button>
            </div>
            {row.req_forwarded_at ? (
              <div className="text-[11px] text-zinc-500">Forwarded <Stamp at={row.req_forwarded_at} /></div>
            ) : null}
          </section>

          {/* 5 · Confirm */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>5 · Confirm appointment</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={pending} className={btn} onClick={() => run(() => confirmAppointment(caseId, "patient"))}>
                Patient confirmed <Stamp at={row.patient_confirmed_at} />
              </button>
              <button type="button" disabled={pending} className={btn} onClick={() => run(() => confirmAppointment(caseId, "vendor"))}>
                Vendor confirmed <Stamp at={row.vendor_confirmed_at} />
              </button>
            </div>
          </section>

          {/* 6 · Draw + complete */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>6 · Draw + completion</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={pending} className={btnPrimary} onClick={() => run(() => markDrawn(caseId))}>
                Mark drawn <Stamp at={row.drawn_at} />
              </button>
              <button type="button" disabled={pending} className={btnPrimary} onClick={() => run(() => confirmCompleted(caseId))}>
                Confirm completed <Stamp at={row.completed_confirmed_at} />
              </button>
            </div>
            <p className="text-[10px] text-zinc-400">Completion = smooth &amp; complete confirmed with vendor + patient.</p>
          </section>

          {/* Notes */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>Notes</div>
            <textarea
              className={input + " min-h-[48px] resize-y"}
              value={notes}
              placeholder="Internal notes…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes !== (row.notes ?? "")) run(() => setApptNotes(caseId, notes));
              }}
            />
          </section>

          {/* Cost summary + price quick-edit */}
          <section className="flex items-center justify-between rounded-md bg-zinc-50 px-2 py-1.5 text-xs">
            <span className="text-zinc-500">
              Vendor: <span className="text-zinc-800">{vendorLabel(row.vendor, row.vendor_other)}</span> · Appt:{" "}
              <span className="text-zinc-800">{fmtDateTime(row.appt_at)}</span> · Cost:{" "}
              <span className="text-zinc-800">{formatPrice(row.price_cents)}</span>
            </span>
            {price !== (row.price_cents != null ? (row.price_cents / 100).toFixed(2) : "") ? (
              <button type="button" disabled={pending} className={btn} onClick={() => run(() => setApptPrice(caseId, parsePriceToCents(price)))}>
                Save cost
              </button>
            ) : null}
          </section>

          {/* Activity */}
          <section className="space-y-1.5">
            <div className={sectionTitle}>Activity</div>
            <ActivityLog caseId={caseId} compact />
          </section>
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-2.5">
          <div className="flex gap-1.5">
            <button type="button" disabled={pending} className={btn} onClick={() => run(() => cancelAppointment(caseId))}>
              Cancel appt
            </button>
            <button
              type="button"
              disabled={pending}
              className={btn}
              onClick={() => {
                if (confirm("Remove this case from mobile phlebotomy (patient self-draws)?")) {
                  run(() => removeCaseFromPhlebotomy(caseId));
                }
              }}
            >
              Remove from phlebotomy
            </button>
          </div>
          <a href={`/labs/${caseId}`} className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline">
            Open case →
          </a>
        </footer>
      </div>
    </dialog>
  );
}
