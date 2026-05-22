"use client";

import { useState } from "react";
import type { ScraperStatusRow } from "./actions";

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function StatusBadge({ row }: { row: ScraperStatusRow }) {
  if (!row.scraperConfigured) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-700">
        Not configured
      </span>
    );
  }
  // Scraper file exists. If we have lifetime attaches, call it green; else
  // amber (configured but never run successfully).
  if (row.lifetimeAttachCount > 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800">
        Configured · {row.lifetimeAttachCount} attaches
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800">
      Configured · never run
    </span>
  );
}

function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers; user can copy manually
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 overflow-x-auto rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] text-zinc-800">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function ScraperRow({ row }: { row: ScraperStatusRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-900">
              {row.labName}
            </span>
            <StatusBadge row={row} />
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {row.notes ?? row.loginUrl}
          </div>
        </div>
        <div className="text-right text-[11px] text-zinc-500">
          <div>Last scrape</div>
          <div className="font-mono text-zinc-700">{fmtTs(row.lastScrapeAt)}</div>
        </div>
        <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/50 px-4 py-3">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
              {row.scraperConfigured ? "Recalibrate" : "Add scraper"}
            </div>
            <p className="mt-1 text-[11.5px] text-zinc-700">
              {row.scraperConfigured ? (
                <>
                  Re-capture the portal session (cookies last ~24h; portal UI
                  changes also require a fresh capture). After running this
                  command, point the worker scraper at the new capture dir if
                  the storage path is hardcoded.
                </>
              ) : (
                <>
                  Capture a fresh Playwright session of this portal. The
                  command opens a browser; log in and walk through downloading
                  one result PDF, then save & exit. Drop the resulting HAR /
                  storage.json path into chat and Claude will scaffold{" "}
                  <span className="font-mono">worker/src/scrapers/{row.key}.ts</span>.
                </>
              )}
            </p>
          </div>
          <CommandBox command={row.captureCommand} />
          <p className="text-[10.5px] text-zinc-500">
            Login URL:{" "}
            <a
              href={row.loginUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-zinc-700 underline-offset-2 hover:underline"
            >
              {row.loginUrl}
            </a>
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function ScrapersPanel({ rows }: { rows: ScraperStatusRow[] }) {
  const configured = rows.filter((r) => r.scraperConfigured).length;
  const total = rows.length;
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
        <p className="text-sm font-medium text-zinc-900">
          {configured} of {total} portals configured
        </p>
        <p className="mt-0.5 text-[11.5px] text-zinc-500">
          A portal is "configured" once a scraper file exists at{" "}
          <span className="font-mono">worker/src/scrapers/&lt;key&gt;.ts</span>{" "}
          and the worker's lab-mapping has a matching entry. Click any row to
          see the bash command for adding or recalibrating it.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <ScraperRow key={row.key} row={row} />
        ))}
      </ul>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[11.5px] text-amber-900">
        <strong>Phase 1 — manual capture flow.</strong> The capture wizard
        (UI-driven Playwright + AI-scaffolded scrapers) lands in a future
        session. For now, run the bash command in your terminal, paste the
        capture path into chat, and Claude scaffolds the scraper file.
      </div>
    </div>
  );
}
