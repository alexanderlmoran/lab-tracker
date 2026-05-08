"use client";

import { useState, useTransition } from "react";
import {
  checkPracticeBetterHealth,
  dumpPracticeBetterFirstPage,
  syncPracticeBetterClientsAction,
} from "../practicebetter-actions";

type Probe =
  | { ok: true; count: number }
  | { ok: false; status: number | null; error: string };

type SyncStatus = {
  finishedAt: string | null;
  recordsSeen: number;
  variantUsed: string | null;
  stoppedEarly: boolean;
  cachedRecordCount: number;
} | null;

type SyncReport =
  | {
      ok: true;
      variantUsed: string;
      recordsSeen: number;
      pagesSeen: number;
      stoppedReason: string;
      rawItemsBeforeDedupe: number;
      attempts: Array<{
        variant: string;
        recordsSeen: number;
        pagesSeen: number;
        stoppedReason: string;
      }>;
    }
  | { ok: false; error: string };

export function PracticeBetterPanel({
  initial,
  initialSync,
}: {
  initial: Probe;
  initialSync: SyncStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [probe, setProbe] = useState<Probe>(initial);
  const [sync, setSync] = useState<SyncStatus>(initialSync);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const [dumpReport, setDumpReport] = useState<string | null>(null);
  const [busy, setBusy] = useState<"recheck" | "sync" | "dump" | null>(null);

  function onRecheck() {
    setBusy("recheck");
    startTransition(async () => {
      const r = await checkPracticeBetterHealth();
      setProbe(r);
      setBusy(null);
    });
  }

  function onSync() {
    setBusy("sync");
    startTransition(async () => {
      const r = await syncPracticeBetterClientsAction();
      setLastReport(r);
      // Refresh derived state with the new run.
      if (r.ok) {
        setSync({
          finishedAt: new Date().toISOString(),
          recordsSeen: r.recordsSeen,
          variantUsed: r.variantUsed,
          stoppedEarly: r.stoppedReason === "max_pages_hit",
          cachedRecordCount: r.recordsSeen,
        });
      }
      setBusy(null);
    });
  }

  function onDump() {
    setBusy("dump");
    setDumpReport(null);
    startTransition(async () => {
      const r = await dumpPracticeBetterFirstPage();
      if (!r.ok) {
        setDumpReport(`Error ${r.status ?? "—"}: ${r.error.slice(0, 240)}`);
      } else {
        setDumpReport(
          `PB reports total count = ${r.count ?? "(missing)"}, hasMore = ${r.hasMore ?? "(missing)"}, items returned = ${r.itemsReturned}. ` +
            `First emails: ${r.firstFiveEmails.join(", ") || "(none)"}.`,
        );
      }
      setBusy(null);
    });
  }

  const unhealthy = !probe.ok;

  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        unhealthy
          ? "border-red-200 bg-red-50"
          : "border-emerald-200 bg-emerald-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p
            className={`font-medium ${
              unhealthy ? "text-red-900" : "text-emerald-900"
            }`}
          >
            PracticeBetter:{" "}
            {unhealthy
              ? `not connected${probe.status ? ` (HTTP ${probe.status})` : ""}`
              : "connected"}
          </p>
          <p
            className={`text-xs ${
              unhealthy ? "text-red-800" : "text-emerald-800"
            }`}
          >
            {unhealthy ? (
              probe.error.slice(0, 240)
            ) : (
              <>
                Cache: {sync?.cachedRecordCount.toLocaleString() ?? 0} client
                {sync?.cachedRecordCount === 1 ? "" : "s"}
                {sync?.finishedAt
                  ? ` · synced ${new Date(sync.finishedAt).toLocaleString()}`
                  : " · never synced"}
                {sync?.variantUsed ? ` · via "${sync.variantUsed}"` : ""}
                {sync?.stoppedEarly ? " · stopped early" : ""}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRecheck}
            disabled={pending}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            {pending && busy === "recheck" ? "Checking…" : "Re-check"}
          </button>
          {!unhealthy ? (
            <>
              <button
                type="button"
                onClick={onDump}
                disabled={pending}
                title="Calls /consultant/records?limit=10 once and shows PB's reported total count."
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                {pending && busy === "dump" ? "Probing…" : "Show PB count"}
              </button>
              <button
                type="button"
                onClick={onSync}
                disabled={pending}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
              >
                {pending && busy === "sync" ? "Syncing…" : "Sync PB clients"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {dumpReport ? (
        <div className="mt-3 rounded border border-zinc-200 bg-white p-2 text-xs text-zinc-800">
          {dumpReport}
        </div>
      ) : null}

      {lastReport ? (
        <div
          className={`mt-3 rounded border bg-white p-2 text-xs ${
            lastReport.ok ? "border-emerald-200" : "border-red-200"
          }`}
        >
          {lastReport.ok ? (
            <>
              <p className="font-medium text-zinc-900">
                Synced {lastReport.recordsSeen.toLocaleString()} unique records
                {lastReport.rawItemsBeforeDedupe !== lastReport.recordsSeen
                  ? ` (${lastReport.rawItemsBeforeDedupe.toLocaleString()} before dedupe)`
                  : ""}{" "}
                over {lastReport.pagesSeen} page
                {lastReport.pagesSeen === 1 ? "" : "s"} via &ldquo;
                {lastReport.variantUsed}&rdquo; (stop:{" "}
                {lastReport.stoppedReason}).
              </p>
              <p className="mt-1 text-zinc-600">Variant attempts:</p>
              <ul className="ml-4 list-disc text-zinc-700">
                {lastReport.attempts.map((a) => (
                  <li key={a.variant}>
                    <code>{a.variant}</code>: {a.recordsSeen} records,{" "}
                    {a.pagesSeen} pages, stop: {a.stoppedReason}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-red-800">Sync failed: {lastReport.error}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
