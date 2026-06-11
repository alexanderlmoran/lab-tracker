"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { InboundAttachment, InboundEmail, LabCase } from "@/lib/types";
import { formatPersonName } from "@/lib/format";
import { getPortalUrlForLab, looksLikeKkEmail } from "@/lib/inbound/detect-notification";
import { InboundRowActions } from "./InboundRowActions";

type EmailRow = InboundEmail & { attachments: InboundAttachment[] };
type SlimCase = Pick<LabCase, "id" | "patient_name" | "lab_name">;

/**
 * Badge meanings — one source of truth, surfaced as tooltips.
 * STATUS answers "where is this email in the pipeline":
 *   parsing…        just ingested, Claude parse hasn't completed
 *   to review       parsed — confirm the case and post (the actionable state)
 *   parse failed    extraction/parse errored — open for the error, Re-parse retries
 *   pull from portal notification-only email (no PDF) — fetch from the lab portal
 *   posted          done — PDF posted / step applied
 * MATCH answers "how sure is the auto-match" and only makes sense while the
 * row is still actionable — once posted, the human resolved it, so it hides.
 */
const STATUS_META: Record<string, { label: string; cls: string; title: string }> = {
  pending: {
    label: "parsing…",
    cls: "bg-amber-100 text-amber-800",
    title: "Just ingested — Claude hasn't parsed it yet. Re-sync or wait.",
  },
  parsed: {
    label: "to review",
    cls: "bg-blue-100 text-blue-800",
    title: "Parsed — confirm the case and post. This is the state that needs you.",
  },
  failed: {
    label: "parse failed",
    cls: "bg-red-100 text-red-700",
    title: "PDF extraction or Claude parse failed — open for the exact error; Re-parse retries.",
  },
  needs_manual_pull: {
    label: "pull from portal",
    cls: "bg-purple-100 text-purple-800",
    title: "Notification-only email (no PDF attached) — fetch the result from the lab portal.",
  },
  applied: {
    label: "posted",
    cls: "bg-emerald-100 text-emerald-800",
    title: "Done — the PDF was posted (or the step applied) on the case.",
  },
  dismissed: {
    label: "dismissed",
    cls: "bg-zinc-200 text-zinc-700",
    title: "Dismissed — kept for the audit trail only.",
  },
};

const CONF_META: Record<string, { label: string; cls: string; title: string }> = {
  high: {
    label: "high match",
    cls: "bg-emerald-100 text-emerald-800",
    title: "Auto-match is confident this belongs to the linked case (name + lab + dates line up).",
  },
  medium: {
    label: "medium match",
    cls: "bg-amber-100 text-amber-800",
    title: "Auto-match found a likely case — verify it's the right ORDER (same patient can have several) before posting.",
  },
  low: {
    label: "low match",
    cls: "bg-zinc-200 text-zinc-700",
    title: "Weak auto-match — treat as unmatched; pick the case yourself.",
  },
  none: {
    label: "no match",
    cls: "bg-red-100 text-red-700",
    title: "No tracker case matched — pick one, or use 'New case + Post to PB' (outside labs usually have no case yet).",
  },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Allison Christiani <allison@…>" → "Allison Christiani". */
function senderName(from: string | null): string {
  if (!from) return "(unknown)";
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m?.[1] ?? from).trim();
}

function isKkEmail(e: EmailRow): boolean {
  return looksLikeKkEmail({
    fromAddress: e.from_address,
    subject: e.subject,
    filenames: (e.attachments ?? []).map((a) => a.filename),
    extractedLab: e.parser_extracted?.lab_name ?? null,
  });
}

/** Status badge, with the Kennedy Krieger special case: applied via the
 * auto-forward reads "forwarded", not "posted" (nothing went to PB). */
function statusFor(e: EmailRow): { label: string; cls: string; title: string } {
  if (e.parser_status === "applied" && e.applied_action === "forwarded_bodybio") {
    return {
      label: "forwarded",
      cls: "bg-indigo-100 text-indigo-800",
      title: "Kennedy Krieger flow — the PDF was forwarded to BodyBio.",
    };
  }
  return (
    STATUS_META[e.parser_status] ?? {
      label: e.parser_status,
      cls: "bg-zinc-100 text-zinc-700",
      title: "",
    }
  );
}

export function InboxList({
  emails,
  activeCases,
}: {
  emails: EmailRow[];
  activeCases: SlimCase[];
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [active, setActive] = useState<EmailRow | null>(null);
  // PDF-less rows (portal notifications, stray text mail) crowd out the rows
  // that carry an actual result, so they're hidden by default — the toggle
  // brings them back when someone needs the "pull from portal" reminders.
  const [showNoPdf, setShowNoPdf] = useState(false);
  const caseById = new Map(activeCases.map((c) => [c.id, c]));
  const noPdfCount = emails.filter((e) => e.attachments.length === 0).length;
  const visible = showNoPdf ? emails : emails.filter((e) => e.attachments.length > 0);

  // Keep the open dialog rendering the FRESH row after a server action
  // revalidates (post/dismiss/re-parse) — same trick as the kanban dialog.
  const current = active ? (emails.find((e) => e.id === active.id) ?? active) : null;

  function open(e: EmailRow) {
    setActive(e);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function close() {
    dialogRef.current?.close();
    setActive(null);
  }
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => setActive(null);
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  return (
    <>
      {noPdfCount > 0 ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => setShowNoPdf((v) => !v)}
            className="text-[11px] text-zinc-500 hover:text-zinc-800 hover:underline"
          >
            {showNoPdf ? "Hide" : "Show"} {noPdfCount} email{noPdfCount === 1 ? "" : "s"} without a
            PDF
          </button>
        </div>
      ) : null}
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        {visible.map((e) => {
          const status = statusFor(e);
          const actionable = e.parser_status === "parsed" || e.parser_status === "pending";
          const conf =
            actionable && e.matched_confidence ? CONF_META[e.matched_confidence] : null;
          const ext = e.parser_extracted;
          const matched = e.matched_case_id ? caseById.get(e.matched_case_id) : null;
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => open(e)}
                className={`grid w-full grid-cols-[7rem_10rem_1fr_auto] items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50 ${
                  actionable ? "" : "bg-zinc-50/60"
                }`}
              >
                <span className="flex flex-col items-start gap-0.5">
                  <span
                    title={status.title}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${status.cls}`}
                  >
                    {status.label}
                  </span>
                  {conf ? (
                    <span
                      title={conf.title}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${conf.cls}`}
                    >
                      {conf.label}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`truncate text-sm ${actionable ? "font-semibold text-zinc-900" : "text-zinc-600"}`}
                >
                  {senderName(e.from_address)}
                </span>
                <span className="min-w-0 truncate text-sm">
                  <span className={actionable ? "font-medium text-zinc-900" : "text-zinc-700"}>
                    {e.subject ?? "(no subject)"}
                  </span>
                  <span className="text-zinc-400">
                    {" — "}
                    {ext?.patient_name
                      ? `${formatPersonName(ext.patient_name)} · ${ext.lab_name ?? "?"}${ext.collected_date ? ` · collected ${ext.collected_date}` : ""}`
                      : (e.attachments[0]?.filename ?? ext?.summary ?? "")}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-zinc-400">
                  {formatDateTime(e.received_at)}
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 ? (
          <li className="p-10 text-center text-sm text-zinc-500">
            {emails.length === 0
              ? "No reports yet — Gmail polling surfaces lab emails here as they arrive."
              : "Every current email is PDF-less — use the toggle above to show them."}
          </li>
        ) : null}
      </ul>

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className="w-full max-w-2xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {current ? (
          <InboxDetail
            email={current}
            matched={current.matched_case_id ? (caseById.get(current.matched_case_id) ?? null) : null}
            activeCases={activeCases}
            onClose={close}
          />
        ) : null}
      </dialog>
    </>
  );
}

function InboxDetail({
  email,
  matched,
  activeCases,
  onClose,
}: {
  email: EmailRow;
  matched: SlimCase | null;
  activeCases: SlimCase[];
  onClose: () => void;
}) {
  const ext = email.parser_extracted;
  const status = statusFor(email);
  const actionable = email.parser_status === "parsed" || email.parser_status === "pending";
  const conf = actionable && email.matched_confidence ? CONF_META[email.matched_confidence] : null;
  const isManualPull = email.parser_status === "needs_manual_pull";
  const portalUrl = isManualPull ? getPortalUrlForLab(ext?.lab_name) : null;
  const isDone = email.parser_status === "applied" || email.parser_status === "dismissed";

  return (
    <div className="flex max-h-[85dvh] flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {status ? (
              <span
                title={status.title}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${status.cls}`}
              >
                {status.label}
              </span>
            ) : null}
            {conf ? (
              <span
                title={conf.title}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${conf.cls}`}
              >
                {conf.label}
              </span>
            ) : null}
            <span className="text-xs text-zinc-500">{formatDateTime(email.received_at)}</span>
          </div>
          <h2 className="mt-1 truncate text-sm font-semibold text-zinc-900">
            {email.subject ?? "(no subject)"}
          </h2>
          <p className="truncate text-xs text-zinc-500">From: {email.from_address ?? "(unknown)"}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 overflow-y-auto px-5 py-4">
        {email.parser_status === "failed" && email.parser_error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            Parser error: {email.parser_error}
          </p>
        ) : null}

        {isManualPull ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-800">
            <span>Notification email — no PDF attached. Pull this result from the lab portal.</span>
            {portalUrl ? (
              <a
                href={portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto rounded-md border border-purple-300 bg-white px-2.5 py-1 text-[11px] font-medium text-purple-800 hover:bg-purple-100"
              >
                Open {ext?.lab_name ?? "lab"} portal →
              </a>
            ) : null}
          </div>
        ) : null}

        {ext ? (
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
            {ext.lab_name ? (
              <>
                <dt className="text-zinc-500">Lab</dt>
                <dd className="text-zinc-900">{ext.lab_name}</dd>
              </>
            ) : null}
            {ext.patient_name ? (
              <>
                <dt className="text-zinc-500">Patient</dt>
                <dd className="text-zinc-900">{formatPersonName(ext.patient_name)}</dd>
              </>
            ) : null}
            {ext.patient_email ? (
              <>
                <dt className="text-zinc-500">Email</dt>
                <dd className="text-zinc-900">{ext.patient_email}</dd>
              </>
            ) : null}
            {ext.patient_dob ? (
              <>
                <dt className="text-zinc-500">DOB</dt>
                <dd className="text-zinc-900">{ext.patient_dob}</dd>
              </>
            ) : null}
            {ext.test_panel ? (
              <>
                <dt className="text-zinc-500">Panel</dt>
                <dd className="text-zinc-900">{ext.test_panel}</dd>
              </>
            ) : null}
            {ext.result_kind ? (
              <>
                <dt className="text-zinc-500">Result</dt>
                <dd className="text-zinc-900">{ext.result_kind}</dd>
              </>
            ) : null}
            {ext.collected_date ? (
              <>
                <dt className="text-zinc-500">Collected</dt>
                <dd className="text-zinc-900">{ext.collected_date}</dd>
              </>
            ) : null}
            {ext.summary ? (
              <>
                <dt className="text-zinc-500">Summary</dt>
                <dd className="text-zinc-900">{ext.summary}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {email.attachments.length > 0 ? (
          <p className="text-xs text-zinc-500">
            📎 {email.attachments.map((a) => a.filename).join(" · ")}
          </p>
        ) : null}

        <div className="text-xs">
          {matched ? (
            <span className="text-zinc-700">
              Matched →{" "}
              <Link
                href={`/labs/${matched.id}`}
                className="font-medium text-zinc-900 hover:underline"
              >
                {formatPersonName(matched.patient_name)} · {matched.lab_name}
              </Link>
            </span>
          ) : !isDone ? (
            <span className="text-zinc-500">No matched case.</span>
          ) : null}
        </div>
      </div>

      <div className="border-t border-zinc-200 px-5 py-3">
        {email.parser_status === "applied" ? (
          <span className="text-xs text-emerald-700">
            {email.applied_action === "forwarded_bodybio"
              ? `Forwarded to BodyBio${email.reviewed_by === "auto:kk-forward" ? " automatically" : ""} — nothing left to do.`
              : `Posted${email.reviewed_by ? ` by ${email.reviewed_by}` : ""} — nothing left to do.`}
          </span>
        ) : email.parser_status === "dismissed" ? (
          <span className="text-xs text-zinc-500">Dismissed.</span>
        ) : (
          <InboundRowActions
            inboundId={email.id}
            matchedCaseId={email.matched_case_id}
            defaultStep={ext?.result_kind === "partial" ? 2 : 4}
            activeCases={activeCases}
            alreadyApplied={false}
            dismissOnly={isManualPull}
            forwardable={isKkEmail(email)}
            canReparse
            suggested={
              ext
                ? {
                    patientName: ext.patient_name ?? null,
                    labName: ext.lab_name ?? null,
                    collectionDate: ext.collected_date ?? null,
                    patientDob: ext.patient_dob ?? null,
                    patientEmail: ext.patient_email ?? null,
                  }
                : null
            }
          />
        )}
      </div>
    </div>
  );
}
