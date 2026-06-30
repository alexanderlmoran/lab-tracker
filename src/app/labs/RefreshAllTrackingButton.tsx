"use client";

import { useState, useTransition } from "react";
import { refreshTrackingForActiveCases } from "./tracking-actions";
import { toolbarBtn } from "./toolbar-styles";

/**
 * Bulk "Refresh all tracking" button for the kanban toolbar. Polls FedEx
 * for every active case with a non-delivered tracking number, capped at
 * 300 per click. Surfaces summary counts inline.
 */
export function RefreshAllTrackingButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onClick() {
    if (
      !confirm(
        "Poll FedEx for every active case with a tracking number?\n\nUp to 300 lookups per click. Already-delivered cases are skipped.",
      )
    )
      return;
    setMsg(null);
    start(async () => {
      const r = await refreshTrackingForActiveCases();
      if (!r.ok) {
        setMsg(`Error: ${r.error}`);
        return;
      }
      const d = r.data!;
      setMsg(
        `Polled ${d.polled} · updated ${d.updated}${d.errors ? ` · ${d.errors} error(s)` : ""}`,
      );
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={toolbarBtn()}
      >
        {pending ? "Polling…" : "Refresh all tracking"}
      </button>
      {msg ? <span className="text-[11px] text-zinc-600">{msg}</span> : null}
    </div>
  );
}
