"use client";

import { useState, useTransition } from "react";
import type { SessionUser } from "@/lib/auth-guard";
import {
  resetEmailTemplate,
  sendTestEmail,
  updateEmailTemplate,
  type EmailTemplateRow,
} from "./actions";
import type { PatientEmailKind } from "@/lib/email/template-data";

const PLACEHOLDER_HINTS: Array<{ token: string; what: string }> = [
  { token: "{patientFirstName}", what: "First name from patient_name" },
  { token: "{patientName}", what: "Full patient name" },
  { token: "{labName}", what: "Lab provider, e.g. Access" },
  { token: "{labPanel}", what: "Panel name (may be empty)" },
  { token: "{labLabel}", what: "Lab + panel joined, e.g. Access Blood Panel" },
  { token: "{turnaroundText}", what: "“5 to 7 business days” etc. (only used in Sample Sent)" },
  { token: "{practiceName}", what: "Practice name from Settings → General" },
];

export function EmailTemplatesPanel({
  templates,
  currentUser,
}: {
  templates: EmailTemplateRow[];
  currentUser: SessionUser;
}) {
  return (
    <div className="space-y-4">
      <details className="rounded-lg border border-zinc-200 bg-white p-4 text-xs text-zinc-600">
        <summary className="cursor-pointer text-zinc-700">
          Available placeholders — click to expand
        </summary>
        <table className="mt-3 w-full text-xs">
          <tbody>
            {PLACEHOLDER_HINTS.map((p) => (
              <tr key={p.token} className="border-t border-zinc-100">
                <td className="px-2 py-1 font-mono text-zinc-900">{p.token}</td>
                <td className="px-2 py-1 text-zinc-500">{p.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {templates.map((t) => (
        <TemplateCard key={t.kind} template={t} currentUser={currentUser} />
      ))}
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
  const [subject, setSubject] = useState(template.subject);
  const [heading, setHeading] = useState(template.heading ?? "");
  const [paragraphs, setParagraphs] = useState(template.paragraphs.join("\n\n"));
  const [bcc, setBcc] = useState(template.bcc.join(", "));
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
        kind: template.kind as PatientEmailKind,
        subject,
        heading,
        paragraphs,
        bcc,
      });
      if (!res.ok) setError(res.error);
      else setSavedNote("Saved.");
    });
  }

  function onReset() {
    if (!confirm(`Reset "${template.label}" to the default copy and BCC list?`)) return;
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      const res = await resetEmailTemplate({
        kind: template.kind as PatientEmailKind,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Hard refresh-style reset: re-bind local state from props would
      // require fresh server data. Easiest is a window reload of /labs/settings.
      window.location.reload();
    });
  }

  function onSendTest() {
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      // If unsaved changes exist, save first so the test reflects current edits.
      if (dirty) {
        const save = await updateEmailTemplate({
          kind: template.kind as PatientEmailKind,
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
        kind: template.kind as PatientEmailKind,
        toEmail: testTo,
      });
      if (!res.ok) setError(res.error);
      else setSavedNote(`Test sent to ${testTo}.`);
    });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">{template.label}</h3>
          <p className="text-xs text-zinc-500">
            {template.isCustomised ? (
              <span className="text-amber-700">Customised — using DB override.</span>
            ) : (
              <span>Using default copy from code.</span>
            )}
          </p>
        </div>
        <button
          type="button"
          disabled={pending || !template.isCustomised}
          onClick={onReset}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>

      <div className="mt-4 space-y-3">
        <Field
          label="Subject"
          value={subject}
          onChange={setSubject}
          hint="The Subject: header. Placeholders work here too."
        />
        {template.kind === "rof_followup" ? (
          <Field
            label="Heading (large text above the greeting)"
            value={heading}
            onChange={setHeading}
            hint="Leave blank to hide. Only Email 4 uses a heading by default."
          />
        ) : null}
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
