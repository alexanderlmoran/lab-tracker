"use client";

import { useState, useTransition } from "react";
import { updateAppSettings, type AppSettings } from "./actions";

export function GeneralSettingsForm({
  initial,
  testRedirectActive,
}: {
  initial: AppSettings;
  /** Non-null when EMAIL_TEST_REDIRECT env is set on the server. Triggers
   * the "test mode active" banner so admins notice their emails are caged. */
  testRedirectActive?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(formData: FormData) {
    setError(null);
    const res = await updateAppSettings(formData);
    if (!res.ok) setError(res.error);
    else setSavedAt(Date.now());
  }

  // The server-side check happens on every email send via env. We can't
  // read process.env from a client component, but we can show the warning
  // when the prop is populated from server-side render. Threaded via a new
  // optional prop so this works without extra round-trips.
  return (
    <form
      action={(formData) => startTransition(() => onSubmit(formData))}
      className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6"
    >
      {testRedirectActive ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Test mode is active.</strong> Every outbound email is being
          redirected to <code>{testRedirectActive}</code> instead of the real
          recipient. Clear <code>EMAIL_TEST_REDIRECT</code> in your environment
          variables to send real patient emails.
        </div>
      ) : null}
      <Field
        name="from_email"
        label="Sending-from email"
        type="email"
        placeholder="alert@centnerlabs.com"
        defaultValue={initial.from_email ?? ""}
        hint="Appears in the From: header on outbound emails. Must be a domain Resend has verified."
      />
      <Field
        name="reply_to_email"
        label="Reply-to email"
        type="email"
        placeholder="labs@centnerhb.com"
        defaultValue={initial.reply_to_email ?? ""}
        hint="When the patient replies, the message goes here."
      />
      <Field
        name="practice_name"
        label="Practice name"
        placeholder="Centner Wellness"
        defaultValue={initial.practice_name ?? ""}
        hint="Shown in the email footer and From: display name."
      />

      <div className="flex items-center justify-between pt-2">
        <div className="text-xs">
          {error ? (
            <span className="text-red-600">{error}</span>
          ) : savedAt ? (
            <span className="text-emerald-600">Saved.</span>
          ) : (
            <span className="text-zinc-400">
              Leave blank to use the environment-variable default.
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  ...rest
}: {
  name: string;
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-700">{label}</span>
      <input
        {...rest}
        name={name}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </label>
  );
}
