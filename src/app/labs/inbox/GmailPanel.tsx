"use client";

import { useState, useTransition } from "react";
import { disconnectGmail, syncGmailNow } from "./actions";

export function GmailPanel({
  initialConnected,
  initialEmail,
  initialLastSyncedAt,
}: {
  initialConnected: boolean;
  initialEmail?: string;
  initialLastSyncedAt?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  function onSync() {
    setStatus("Syncing…");
    startTransition(async () => {
      const r = await syncGmailNow();
      if (!r.ok) {
        setStatus(`Sync failed: ${r.error}`);
        return;
      }
      const d = r.data;
      setStatus(
        d
          ? `Sync done — ${d.processed} new, ${d.skipped} skipped, ${d.errors} errors.`
          : "Sync done.",
      );
    });
  }

  function onDisconnect() {
    if (!confirm("Disconnect Gmail? You'll need to reconnect to sync again."))
      return;
    startTransition(async () => {
      const r = await disconnectGmail();
      if (!r.ok) {
        setStatus(`Disconnect failed: ${r.error}`);
        return;
      }
      window.location.reload();
    });
  }

  if (!initialConnected) {
    return (
      <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-white p-3 text-sm">
        <div>
          <p className="font-medium text-zinc-900">Gmail not connected</p>
          <p className="text-xs text-zinc-500">
            Authorize access to <code>labs@centnerhb.com</code> to auto-import
            lab reports.
          </p>
        </div>
        <a
          href="/api/gmail/oauth/start"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          Connect Gmail
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
      <div>
        <p className="font-medium text-emerald-900">
          Connected: {initialEmail}
        </p>
        <p className="text-xs text-emerald-800">
          {initialLastSyncedAt
            ? `Last sync: ${new Date(initialLastSyncedAt).toLocaleString()}`
            : "Never synced yet."}
          {status ? ` · ${status}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSync}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={pending}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
