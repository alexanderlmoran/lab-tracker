"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import type { SessionUser } from "@/lib/auth-guard";
import { LAB_CATALOG } from "@/lib/labs/catalog";
import {
  createCustomEmailTemplate,
  deleteCustomEmailTemplate,
  resetEmailTemplate,
  sendTestEmail,
  setEmailTemplateEnabled,
  updateCustomEmailTemplate,
  updateEmailTemplate,
  type CustomTemplateSuggestion,
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

const PATIENT_KIND_LABEL: Record<string, string> = {
  sample_sent: "1 · Sample sent",
  partial_uploaded: "2 · Partial results uploaded",
  complete_uploaded: "3 · Complete results uploaded",
  rof_followup: "4 · ROF follow-up",
};

export function EmailTemplatesPanel({
  templates,
  currentUser,
  suggestions,
  knownEmails,
}: {
  templates: EmailTemplateRow[];
  currentUser: SessionUser;
  suggestions: CustomTemplateSuggestion[];
  knownEmails: string[];
}) {
  const patient = templates.filter(
    (t) => t.group === "patient" && t.triggerLabName == null,
  );
  const staff = templates.filter((t) => t.group === "staff");
  const custom = templates.filter((t) => t.triggerLabName != null);

  const [showCreate, setShowCreate] = useState(false);
  const emailsDatalistId = useId();

  return (
    <div className="space-y-6">
      <datalist id={emailsDatalistId}>
        {knownEmails.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      <TemplateGroup
        heading="Patient emails"
        description="The 4 emails patients receive as their case moves through the pipeline. Toggle In use to suppress sends without losing the template."
        templates={patient}
        currentUser={currentUser}
        emailsDatalistId={emailsDatalistId}
      />
      <TemplateGroup
        heading="Staff emails"
        description="Sent to staff accounts on invite and password-reset. The {magicLink} placeholder is required — leave it in, or the recipient has no way to sign in."
        templates={staff}
        currentUser={currentUser}
        emailsDatalistId={emailsDatalistId}
      />

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              Custom per-lab templates
            </h3>
            <p className="text-xs text-zinc-500">
              Override one of the 4 patient emails for a specific lab. When a
              case's lab matches, this template is used instead of the global
              one. (Example: Peptides ships product, not a lab kit — the
              Sample-sent email needs different copy.)
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            + Add custom template
          </button>
        </div>
        {custom.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-500">
            No per-lab overrides yet.
          </p>
        ) : (
          <div className="space-y-2">
            {custom.map((t) => (
              <TemplateCard
                key={t.id ?? t.kind}
                template={t}
                currentUser={currentUser}
                emailsDatalistId={emailsDatalistId}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate ? (
        <CreateCustomDialog
          suggestions={suggestions}
          emailsDatalistId={emailsDatalistId}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </div>
  );
}

function TemplateGroup({
  heading,
  description,
  templates,
  currentUser,
  emailsDatalistId,
}: {
  heading: string;
  description: string;
  templates: EmailTemplateRow[];
  currentUser: SessionUser;
  emailsDatalistId: string;
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
          <TemplateCard
            key={t.id ?? t.kind}
            template={t}
            currentUser={currentUser}
            emailsDatalistId={emailsDatalistId}
          />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  currentUser,
  emailsDatalistId,
}: {
  template: EmailTemplateRow;
  currentUser: SessionUser;
  emailsDatalistId: string;
}) {
  const isCustom = template.id != null && template.triggerLabName != null;
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
      const res = isCustom
        ? await updateCustomEmailTemplate({
            id: template.id!,
            subject,
            heading,
            paragraphs,
            bcc,
          })
        : await updateEmailTemplate({
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
    if (isCustom) return; // per-lab rows inherit the global enabled state.
    setError(null);
    setSavedNote(null);
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
    if (isCustom) {
      if (
        !confirm(
          `Delete the ${template.triggerLabName}-specific override for "${PATIENT_KIND_LABEL[template.kind] ?? template.kind}"? The global template will be used instead.`,
        )
      ) {
        return;
      }
      setError(null);
      setSavedNote(null);
      startTransition(async () => {
        const res = await deleteCustomEmailTemplate({ id: template.id! });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        window.location.reload();
      });
      return;
    }
    if (!confirm(`Reset "${template.label}" to the default copy and BCC list?`)) return;
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      const res = await resetEmailTemplate({ kind: template.kind });
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
        const save = isCustom
          ? await updateCustomEmailTemplate({
              id: template.id!,
              subject,
              heading,
              paragraphs,
              bcc,
            })
          : await updateEmailTemplate({
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
        triggerLabName: template.triggerLabName,
      });
      if (!res.ok) setError(res.error);
      else setSavedNote(`Test sent to ${testTo}.`);
    });
  }

  const resetLabel = isCustom ? "Delete override" : "Reset to default";

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-white ${
        enabled ? "border-zinc-200" : "border-zinc-200 opacity-75"
      }`}
    >
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
              {isCustom ? (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-800">
                  Per-lab
                </span>
              ) : null}
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
              {template.isCustomised && !isCustom ? (
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

        {!isCustom ? (
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
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-zinc-100 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-zinc-500">
              {isCustom ? (
                <span className="text-violet-700">
                  Per-lab override — fires when a case's lab_name = “{template.triggerLabName}”.
                </span>
              ) : template.isCustomised ? (
                <span className="text-amber-700">
                  Customised — using DB override.
                </span>
              ) : (
                <span>Using default copy from code.</span>
              )}
            </p>
            <button
              type="button"
              disabled={pending || (!isCustom && !template.isCustomised)}
              onClick={onReset}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resetLabel}
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
                hint="Leave blank to hide."
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
            <BccField
              value={bcc}
              onChange={setBcc}
              emailsDatalistId={emailsDatalistId}
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
                list={emailsDatalistId}
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

function CreateCustomDialog({
  suggestions,
  emailsDatalistId,
  onClose,
}: {
  suggestions: CustomTemplateSuggestion[];
  emailsDatalistId: string;
  onClose: () => void;
}) {
  const labOptions = useMemo(
    () =>
      LAB_CATALOG
        .filter((e) => !e.retired)
        .map((e) => ({ name: e.provider, display: e.name }))
        // Deduplicate by provider — admins pick a provider (case.lab_name), not a panel.
        .filter(
          (item, idx, arr) =>
            arr.findIndex((x) => x.name === item.name) === idx,
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  const [kind, setKind] = useState<CustomTemplateSuggestion["kind"]>("sample_sent");
  const [lab, setLab] = useState<string>("Peptides");
  const [subject, setSubject] = useState("");
  const [heading, setHeading] = useState("");
  const [paragraphs, setParagraphs] = useState("");
  const [bcc, setBcc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [touched, setTouched] = useState(false);

  // Auto-fill from suggestion whenever (kind, lab) lines up with one — but
  // only while the admin hasn't typed anything (touched=false), to avoid
  // clobbering their edits.
  useEffect(() => {
    if (touched) return;
    const hit = suggestions.find(
      (s) => s.kind === kind && s.triggerLabName === lab,
    );
    if (hit) {
      setSubject(hit.subject);
      setHeading(hit.heading ?? "");
      setParagraphs(hit.paragraphs.join("\n\n"));
    } else {
      setSubject("");
      setHeading("");
      setParagraphs("");
    }
  }, [kind, lab, suggestions, touched]);

  function markTouched<T>(setter: (v: T) => void) {
    return (v: T) => {
      setTouched(true);
      setter(v);
    };
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await createCustomEmailTemplate({
        kind,
        triggerLabName: lab,
        subject,
        heading,
        paragraphs,
        bcc,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-xl space-y-3 rounded-lg bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-zinc-900">
              New per-lab template
            </h3>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Picks a stage + lab. Whenever a case at that stage has that
              lab_name, this template is used instead of the global one.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-900"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">Stage</span>
            <select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as CustomTemplateSuggestion["kind"])
              }
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900"
            >
              {Object.entries(PATIENT_KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">
              Triggering lab
            </span>
            <select
              value={lab}
              onChange={(e) => setLab(e.target.value)}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900"
            >
              {labOptions.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-zinc-700">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => markTouched(setSubject)(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-zinc-700">
            Heading (optional, large text above the greeting)
          </span>
          <input
            type="text"
            value={heading}
            onChange={(e) => markTouched(setHeading)(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-zinc-700">
            Body — one paragraph per blank-line-separated block
          </span>
          <textarea
            rows={8}
            value={paragraphs}
            onChange={(e) => markTouched(setParagraphs)(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          />
        </label>

        <BccField
          value={bcc}
          onChange={markTouched(setBcc)}
          emailsDatalistId={emailsDatalistId}
        />

        {error ? (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create template"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * BCC editor with a "Quick add" picker fed from previously-used addresses.
 * The main input stays comma-separated for power-users; the dropdown +
 * Add button appends one address at a time without retyping (and without
 * the typos that "cetnerwellness" comes from).
 */
function BccField({
  value,
  onChange,
  emailsDatalistId,
}: {
  value: string;
  onChange: (v: string) => void;
  emailsDatalistId: string;
}) {
  const [pick, setPick] = useState("");

  const existing = useMemo(() => {
    const set = new Set<string>();
    for (const part of value.split(/[,\n;]/)) {
      const v = part.trim().toLowerCase();
      if (v) set.add(v);
    }
    return set;
  }, [value]);

  function addPicked() {
    const v = pick.trim();
    if (!v) return;
    if (existing.has(v.toLowerCase())) {
      setPick("");
      return;
    }
    const sep = value.trim() ? ", " : "";
    onChange(`${value}${sep}${v}`);
    setPick("");
  }

  return (
    <div>
      <label className="block">
        <span className="text-xs font-medium text-zinc-700">
          BCC recipients (comma-separated)
        </span>
        <input
          type="text"
          list={emailsDatalistId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          Internal staff who silently get a copy of every send of this kind.
          The patient never sees this list.
        </p>
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="email"
          list={emailsDatalistId}
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addPicked();
            }
          }}
          placeholder="Quick add from previously-used addresses"
          className="flex-1 min-w-[200px] rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-900 placeholder:text-zinc-400"
        />
        <button
          type="button"
          onClick={addPicked}
          disabled={!pick.trim()}
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Add
        </button>
      </div>
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
