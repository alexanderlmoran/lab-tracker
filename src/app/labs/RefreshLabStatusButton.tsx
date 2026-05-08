"use client";

import { useState, useTransition } from "react";
import { refreshLabStatus } from "./actions";

export function RefreshLabStatusButton({ caseId }: { caseId: string }) {
  const [pending, startTransition] = useTransition();
  const [last, setLast] = useState<{
    status: string;
    message?: string;
    adapter: string | null;
  } | null>(null);

  function onClick() {
    startTransition(async () => {
      const r = await refreshLabStatus({ caseId });
      if (!r.ok) {
        setLast({ status: "error", message: r.error, adapter: null });
        return;
      }
      setLast(r.data ?? null);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {pending ? "Checking…" : "Refresh lab status"}
      </button>
      {last ? (
        <p className="text-[11px] text-zinc-500">
          {last.adapter ? `${last.adapter}: ` : ""}
          <span className="font-medium text-zinc-700">{last.status}</span>
          {last.message ? ` — ${last.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}
