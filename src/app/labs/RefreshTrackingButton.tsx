"use client";

import { useState, useTransition } from "react";
import { refreshTrackingForCase } from "./tracking-actions";

/**
 * Per-case "Refresh tracking" button. Shown on case detail next to the
 * existing RefreshLabStatusButton. Inline result display so the user
 * sees the new status without re-opening the dialog.
 */
export function RefreshTrackingButton({ caseId }: { caseId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onClick() {
    setMsg(null);
    start(async () => {
      const r = await refreshTrackingForCase(caseId);
      if (!r.ok) {
        setMsg(`Error: ${r.error}`);
        return;
      }
      const d = r.data!;
      const parts: string[] = [d.status];
      if (d.location) parts.push(d.location);
      if (d.detail) parts.push(d.detail);
      setMsg(parts.join(" · "));
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? "Polling…" : "Refresh tracking"}
      </button>
      {msg ? <span className="text-[11px] text-zinc-600">{msg}</span> : null}
    </div>
  );
}
