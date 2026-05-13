"use client";

import { useState, useTransition } from "react";
import type { SessionUser } from "@/lib/auth-guard";
import {
  resetEmailTemplate,
  sendTestEmail,
  setEmailTemplateEnabled,
  updateEmailTemplate,
  type EmailTemplateRow,
} from "./actions";

const PLACEHOLDER_DESCRIPTIONS: Record<string, string> = {
  "{patientFirstName}": "First name from patient_name",
  "{patientName}": "Full patient name",
  "{labName}": "Lab provider, e.g. Access",
  "{labPanel}": "Panel name (may be empty)",
  "{labLabel}": "Lab + panel joined, e.g. Access Blood Panel",
  "{turnaroundText}":
    "“5 to 7 business days” etc. (only resolves on Sample Sent)",
  "{practiceName}": "Practice name from Settings → General",
  "{inviteeFirstName}": "First name of the person being emailed",
  "{inviteeName}": "Full name of the person being emailed",
  "{inviteeEmail}": "Email address of the person being emailed",
  "{magicLink}": "The Supabase sign-in / reset link (single use)",
};

export function EmailTemplatesPanel({
  templates,
  currentUser,
}: {
  templates: EmailTemplateRow[];
  currentUser: SessionUser;
}) {
  const patient = templates.filter((t) => t.group === "patient");
  const staff = templates.filter((t) => t.group === "staff");

  return (
    <div className="space-y-6">
      <TemplateGroup
        heading="Patient emails"
        description="The 4 emails patients receive as their case moves through the pipeline. Toggle In use to suppress sends without losing the template."
        templates={patient}
        currentUser={currentUser}
      />
      <TemplateGroup
        heading="Staff emails"
        description="Sent to staff accounts on invite and password-reset. The {magicLink} placeholder is required — leave it in, or the recipient has no way to sign in."
        templates={staff}
        currentUser={currentUser}
      />
    </div>
  );
}

function TemplateGroup({
  heading,
  description,
  templates,
  currentUser,
}: {
  heading: string;
  description: string;
  templates: EmailTemplateRow[];
  currentUser: SessionUser;
}) {
  if (templates.length === 0) return null;
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">{heading}</h3>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div className="space-y-2">
        {templates.map((t) => (
          <TemplateCard key={t.kind} template={t} currentUser={currentUser} />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  currentUser,
}: {
  template: EmailTemplateRow;
  currentUser: SessionUser;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(template.subject);
  const [heading, setHeading] = useState(template.heading ?? "");
  const [paragraphs, setParagraphs] = useState(template.paragraphs.join("\n\n"));
  const [bcc, setBcc] = useState(template.bcc.join(", "));
  const [enabled, setEnabled] = useState(template.enabled);
  const [testTo, setTestTo] = useState(currentUser.email);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    subject !== template.subject ||
    heading !== (template.heading ?? "") ||
    paragraphs !== template.paragraphs.join("\n\n") ||
    bcc !== template.bcc.join(", ");

  function onSave() {
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      const res = await updateEmailTemplate({
        kind: template.kind,
        subject,
        heading,
        paragraphs,
        bcc,
      });
      if (!res.ok) setError(res.error);
      else setSavedNote("Saved.");
    });
  }

  function onToggleEnabled(next: boolean) {
    setError(null);
    setSavedNote(null);
    // Optimistic: flip immediately so the UI feels responsive. Roll back on error.
    setEnabled(next);
    startTransition(async () => {
      const res = await setEmailTemplateEnabled({
        kind: template.kind,
        enabled: next,
      });
      if (!res.ok) {
        setEnabled(!next);
        setError(res.error);
      }
    });
  }

  function onReset() {
    if (!confirm(`Reset "${template.label}" to the default copy and BCC list?`)) return;
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      const res = await resetEmailTemplate({
        kind: template.kind,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      window.location.reload();
    });
  }

  function onSendTest() {
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      if (dirty) {
        const save = await updateEmailTemplate({
          kind: template.kind,
          subject,
          heading,
          paragraphs,
          bcc,
        });
        if (!save.ok) {
          setError(save.error);
          return;
        }
      }
      const res = await sendTestEmail({
        kind: template.kind,
        toEmail: testTo,
      });
      if (!res.ok) setError(res.error);
      else setSavedNote(`Test sent to ${testTo}.`);
    });
  }

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-white ${
        enabled ? "border-zinc-200" : "border-zinc-200 opacity-75"
      }`}
    >
      {/* Header — always visible, click to expand */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <span
            aria-hidden
            className={`inline-block text-xs text-zinc-400 transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-900">
                {template.label}
              </span>
              {!enabled ? (
                <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700">
                  Disabled
                </span>
              ) : null}
              {dirty ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                  Unsaved
                </span>
              ) : null}
              {template.isCustomised ? (
                <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700">
                  Customised
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-zinc-500">
              {subject || <em>(no subject)</em>}
            </p>
          </div>
        </button>

        {/* In-use toggle — sits outside the expand button so clicking it
            doesn't also toggle the disclosure. */}
        <label
          className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-zinc-700"
          title={enabled ? "This email is currently being sent." : "Sends are suppressed for this kind."}
        >
          <span className="select-none">In use</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            disabled={pending}
            className="h-4 w-4 cursor-pointer rounded border-zinc-300"
          />
        </label>
      </div>

      {/* Body — collapsible */}
      {open ? (
        <div className="border-t border-zinc-100 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-zinc-500">
              {template.isCustomised ? (
                <span className="text-amber-700">
                  Customised — using DB override.
                </span>
              ) : (
                <span>Using default copy from code.</span>
              )}
            </p>
            <button
              type="button"
              disabled={pending || !template.isCustomised}
              onClick={onReset}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset to default
            </button>
          </div>

          <div className="mt-3 space-y-3">
            <Field
              label="Subject"
              value={subject}
              onChange={setSubject}
              hint="The Subject: header. Placeholders work here too."
            />
            {template.heading !== null || heading.trim().length > 0 ? (
              <Field
                label="Heading (large text above the greeting)"
                value={heading}
                onChange={setHeading}
                hint="Leave blank to hide. Defaults to populated only on ROF follow-up."
              />
            ) : null}

            <details className="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-[11px] text-zinc-600">
              <summary className="cursor-pointer">
                Available placeholders for this email
              </summary>
              <table className="mt-2 w-full">
                <tbody>
                  {template.placeholders.map((token) => (
                    <tr key={token} className="border-t border-zinc-200">
                      <td className="px-2 py-1 font-mono text-zinc-900">{token}</td>
                      <td className="px-2 py-1 text-zinc-500">
                        {PLACEHOLDER_DESCRIPTIONS[token] ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            <div>
              <label className="block text-xs font-medium text-zinc-700">
                Body — one paragraph per blank-line-separated block
              </label>
              <textarea
                rows={Math.min(14, Math.max(6, paragraphs.split(/\n/).length + 2))}
                value={paragraphs}
                onChange={(e) => setParagraphs(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Patients see each paragraph as a separate block in the email. Blank line = new paragraph.
              </p>
            </div>
            <Field
              label="BCC recipients (comma-separated)"
              value={bcc}
              onChange={setBcc}
              hint="Internal staff who silently get a copy of every send of this kind. The patient never sees this list."
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4">
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={onSave}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>

            <div className="flex flex-1 items-center gap-2">
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="Test recipient email"
                className="flex-1 min-w-[200px] rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
              />
              <button
                type="button"
                disabled={pending || !testTo}
                onClick={onSendTest}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {pending ? "Sending…" : "Send test"}
              </button>
            </div>
          </div>

          {error ? (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          {savedNote ? (
            <p className="mt-2 text-xs text-emerald-700">{savedNote}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-700">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </label>
  );
}
