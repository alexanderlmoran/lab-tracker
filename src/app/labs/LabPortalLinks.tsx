"use client";

import { useEffect, useState } from "react";
import type { LabPortal } from "@/lib/inbound/detect-notification";
import { fetchPortalsForLab } from "./actions";

export function LabPortalLinks({ labName }: { labName: string }) {
  const [portals, setPortals] = useState<LabPortal[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPortals(null);
    fetchPortalsForLab(labName)
      .then((rows) => {
        if (!cancelled) setPortals(rows);
      })
      .catch(() => {
        if (!cancelled) setPortals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [labName]);

  if (portals === null) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-zinc-400">
        loading…
      </span>
    );
  }
  if (portals.length === 0) {
    return (
      <span
        className="text-[10px] uppercase tracking-wide text-zinc-400"
        title="No portal URL on file for this lab. Add one in Settings → Lab portals."
      >
        no portal
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {portals.map((p, i) => (
        <a
          key={`${p.key}-${i}`}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          title={p.label}
        >
          Portal{p.audience ? ` · ${p.audience}` : ""}
          <span aria-hidden className="text-zinc-400">
            ↗
          </span>
        </a>
      ))}
    </div>
  );
}
