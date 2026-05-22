"use client";

import { useState, useTransition } from "react";
import {
  listCaptureDirsForPortal,
  scaffoldScraperFromTemplate,
  type CaptureDirInfo,
  type ScraperStatusRow,
} from "./actions";

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

function HealthBadge({ row }: { row: ScraperStatusRow }) {
  const h = row.health;
  if (!h) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500">
        ◌ Not yet probed
      </span>
    );
  }
  if (h.consecutiveFailures >= 2) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-medium text-red-800"
        title={h.lastError ?? "Probe failed"}
      >
        ● Down · {h.consecutiveFailures}× failed
      </span>
    );
  }
  if (h.consecutiveFailures === 1) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800"
        title={h.lastError ?? "Last probe failed"}
      >
        ◐ Flaky · 1 fail
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800"
      title={`HTTP ${h.lastStatusCode ?? "—"} at ${h.lastCheckAt ?? "unknown"}`}
    >
      ● Reachable
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ScaffoldWizard({ row, onScaffolded }: { row: ScraperStatusRow; onScaffolded: () => void }) {
  const [captures, setCaptures] = useState<CaptureDirInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();
  const [success, setSuccess] = useState<string | null>(null);

  function refresh() {
    setError(null);
    setSuccess(null);
    startLoading(async () => {
      try {
        const data = await listCaptureDirsForPortal(row.key);
        setCaptures(data);
        if (data.length === 0) {
          setError("No captures found yet. Run the bash command above first.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to list captures");
      }
    });
  }

  function scaffold(timestamp: string) {
    setBusyKey(timestamp);
    setError(null);
    setSuccess(null);
    startLoading(async () => {
      try {
        const res = await scaffoldScraperFromTemplate(row.key, timestamp);
        if (!res.ok) {
          setError(res.error ?? "Scaffold failed");
        } else {
          setSuccess(`Scaffolded ${res.data?.relPath}. Open it in your editor, replace the TODO body with portal logic, then restart npm run dev.`);
          onScaffolded();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Scaffold failed");
      } finally {
        setBusyKey(null);
      }
    });
  }

  return (
    <div className="space-y-2 border-t border-dashed border-zinc-200 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] text-zinc-700">
          After running the command above, click below to pick up the capture
          and scaffold the scraper file.
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={isLoading}
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {isLoading && captures === null ? "Checking…" : "Check for captures"}
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-700">{error}</p> : null}
      {success ? (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
          {success}
        </p>
      ) : null}
      {captures && captures.length > 0 ? (
        <ul className="space-y-1">
          {captures.map((c) => (
            <li
              key={c.timestamp}
              className="flex items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-zinc-800">{c.timestamp}</div>
                <div className="text-[10.5px] text-zinc-500">
                  storage.json {c.hasStorageJson ? "✓" : "✗"} · HAR{" "}
                  {c.hasHar ? `${fmtBytes(c.harBytes)} ✓` : "✗"}
                  {c.capturedAt
                    ? ` · ${c.capturedAt.toISOString().slice(0, 16).replace("T", " ")}`
                    : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => scaffold(c.timestamp)}
                disabled={busyKey !== null || !c.hasStorageJson}
                className="shrink-0 rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {busyKey === c.timestamp ? "Scaffolding…" : "Scaffold scraper"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ScraperRow({ row, onChange }: { row: ScraperStatusRow; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-900">
              {row.labName}
            </span>
            <StatusBadge row={row} />
            <HealthBadge row={row} />
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
                  one result PDF, then save & exit. The wizard below picks up
                  the resulting capture and scaffolds{" "}
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
          {!row.scraperConfigured ? (
            <ScaffoldWizard row={row} onScaffolded={onChange} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ScrapersPanel({ rows }: { rows: ScraperStatusRow[] }) {
  // Lightweight refresh trigger: bumping the key on the <ul> remounts rows
  // so a newly-scaffolded portal recomputes its filesystem check. Avoids a
  // full router refresh + double fetch.
  const [refreshTick, setRefreshTick] = useState(0);
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
          expand, run the capture command, then scaffold the scraper from the
          wizard below it.
        </p>
      </div>
      <ul key={refreshTick} className="space-y-2">
        {rows.map((row) => (
          <ScraperRow
            key={row.key}
            row={row}
            onChange={() => {
              // Force a soft refresh of the page so server-side
              // listScraperStatus() re-runs and the new scraper file is
              // detected by the existsSync() check.
              setRefreshTick((t) => t + 1);
              if (typeof window !== "undefined") window.location.reload();
            }}
          />
        ))}
      </ul>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[11.5px] text-amber-900">
        <strong>Phase 2 — capture-driven scaffolding.</strong> The wizard
        scaffolds a stub scraper file from the captured session — it does
        not yet read the HAR with AI to write portal-specific request code.
        After scaffold, open the new file in your editor (path is shown on
        success), fill in the TODO body using the HAR / recorded.js as
        reference, then restart <span className="font-mono">npm run dev</span>.
      </div>
    </div>
  );
}
