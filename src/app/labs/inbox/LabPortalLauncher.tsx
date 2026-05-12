"use client";

import { useMemo, useState } from "react";
import { LAB_PORTALS } from "@/lib/inbound/detect-notification";

/** Quick-launch grid of all the lab portals at the top of the Inbox tab.
 * Useful when staff just need to check a portal for new results (no inbox
 * row yet) — one click and they're at the sign-in page. Buttons open in a
 * new tab so they don't lose the Inbox view. */
export function LabPortalLauncher() {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return LAB_PORTALS;
    return LAB_PORTALS.filter((p) =>
      `${p.label} ${p.key}`.toLowerCase().includes(f),
    );
  }, [filter]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Lab portals</h3>
          <p className="text-xs text-zinc-500">
            Quick-launch a sign-in page in a new tab. Updates here propagate to
            the per-row buttons below.
          </p>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-40 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
        />
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((p, i) => (
          <li key={`${p.key}-${i}`}>
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
            >
              <span className="truncate">{p.label}</span>
              <span aria-hidden className="text-zinc-400">↗</span>
            </a>
          </li>
        ))}
      </ul>
      {filtered.length === 0 ? (
        <p className="text-xs text-zinc-500">No portals match that filter.</p>
      ) : null}
    </div>
  );
}
