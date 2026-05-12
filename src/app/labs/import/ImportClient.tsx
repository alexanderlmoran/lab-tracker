"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { parseCsv } from "@/lib/csv/parse";
import {
  extractShippingRowsForYear,
  rowToDrafts,
  type ImportDraft,
} from "@/lib/labs/import-normalize";
import { LAB_CATALOG, findLabByName } from "@/lib/labs/catalog";
import {
  commitImport,
  enrichImportDrafts,
  listRecentImports,
  rollbackImport,
  type EnrichedDraft,
  type PBSuggestion,
  type RecentImport,
} from "./actions";

type Phase = "upload" | "preview" | "committing" | "done";

function formatImportedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function RollbackByIdSection() {
  const [recent, setRecent] = useState<RecentImport[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await listRecentImports();
      if (cancelled) return;
      if (r.ok) {
        setRecent(r.data ?? []);
        setLoadErr(null);
      } else {
        setLoadErr(r.error ?? "Failed to load recent imports");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  function onRollback(item: RecentImport) {
    // Typed confirmation — destructive action, want a real "yes I mean it"
    // gate, not a one-click misclick. Browser prompt() is good enough here.
    const phrase = window.prompt(
      `Roll back this import?\n\n` +
        `${item.caseCount} case(s) imported at ${formatImportedAt(item.importedAtIso)}.\n\n` +
        `Type ROLLBACK to confirm. Cases soft-delete to /labs/deleted (recoverable).`,
    );
    if (phrase !== "ROLLBACK") {
      if (phrase != null) setMessage("Rollback cancelled — phrase didn't match.");
      return;
    }
    setBusyId(item.bulkImportId);
    start(async () => {
      const r = await rollbackImport(item.bulkImportId);
      setBusyId(null);
      if (!r.ok) {
        setMessage(`Rollback failed: ${r.error}`);
        return;
      }
      setMessage(
        `Rolled back ${r.data?.deletedCount ?? 0} case(s) from ${formatImportedAt(item.importedAtIso)}. Recoverable from /labs/deleted.`,
      );
      setReloadTick((t) => t + 1);
    });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-zinc-900">
        Roll back a past import
      </h3>
      <p className="mt-1 text-xs text-zinc-500">
        Up to 10 most-recent imports with active (non-deleted) cases. Click
        Roll back and type{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono">
          ROLLBACK
        </code>{" "}
        to confirm.
      </p>

      {loadErr ? (
        <p className="mt-3 text-xs text-red-700">Couldn&rsquo;t load: {loadErr}</p>
      ) : recent === null ? (
        <p className="mt-3 text-xs text-zinc-400">Loading…</p>
      ) : recent.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-400">No recent imports.</p>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {recent.map((item) => (
            <li
              key={item.bulkImportId}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="font-medium text-zinc-900">
                  {item.caseCount} case{item.caseCount === 1 ? "" : "s"}
                  <span className="ml-2 font-normal text-zinc-500">
                    · {formatImportedAt(item.importedAtIso)}
                  </span>
                </div>
                <div className="truncate font-mono text-[10px] text-zinc-400">
                  {item.bulkImportId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRollback(item)}
                disabled={busyId === item.bulkImportId}
                className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {busyId === item.bulkImportId ? "Rolling back…" : "Roll back"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {message ? (
        <p className="mt-3 rounded bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}

const TARGET_YEAR = 2026;

function newUuid(): string {
  // Browser-side: prefer crypto.randomUUID; fall back to a timestamp-rand mix
  // for ancient browsers (still RFC 4122-ish, good enough for an audit ID).
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const r = (n: number) =>
    [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${r(8)}-${r(4)}-4${r(3)}-a${r(3)}-${r(12)}`;
}

export function ImportClient() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [drafts, setDrafts] = useState<EnrichedDraft[]>([]);
  const [parseStats, setParseStats] = useState<{
    totalDataRows: number;
    inYearRows: number;
    draftCount: number;
  } | null>(null);
  const [, startEnrich] = useTransition();
  const [, startCommit] = useTransition();
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [bulkImportId, setBulkImportId] = useState<string | null>(null);
  const [rollbackMessage, setRollbackMessage] = useState<string | null>(null);
  const [, startRollback] = useTransition();

  async function onFile(file: File) {
    const text = await file.text();
    const table = parseCsv(text);
    const { rows, totalDataRows } = extractShippingRowsForYear(table, TARGET_YEAR);

    const localDrafts: ImportDraft[] = [];
    for (const r of rows) localDrafts.push(...rowToDrafts(r));

    setParseStats({
      totalDataRows,
      inYearRows: rows.length,
      draftCount: localDrafts.length,
    });

    startEnrich(async () => {
      const result = await enrichImportDrafts(localDrafts);
      if (result.ok) {
        setDrafts(result.data ?? []);
        setPhase("preview");
      } else {
        alert(`Enrichment failed: ${result.error}`);
      }
    });
  }

  function updateDraft(key: string, patch: Partial<EnrichedDraft>) {
    setDrafts((prev) =>
      prev.map((d) => (d.draftKey === key ? { ...d, ...patch } : d)),
    );
  }

  function pickCandidate(key: string, c: PBSuggestion) {
    // CSV trumps the past-patient suggestion on name — only fill in the
    // contact fields. Operator can still edit the name manually if needed.
    updateDraft(key, {
      patientEmail: c.email,
      patientPhone: c.phone,
      patientDobIso: c.dobIso,
      matchKind: "exact_one",
      warning: null,
    });
  }

  function setLabFromCatalogName(key: string, catalogName: string) {
    const entry = findLabByName(catalogName);
    if (!entry) return;
    const draft = drafts.find((d) => d.draftKey === key);
    if (!draft) return;

    // Recompute expected dates from the (possibly different) turnaround.
    let minIso: string | null = null;
    let maxIso: string | null = null;
    if (draft.sampleSentAtIso && (entry.turnaroundDaysMin || entry.turnaroundDaysMax)) {
      const start = new Date(draft.sampleSentAtIso + "T00:00:00").getTime();
      if (entry.turnaroundDaysMin != null) {
        const d = new Date(start + entry.turnaroundDaysMin * 86_400_000);
        minIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      if (entry.turnaroundDaysMax != null) {
        const d = new Date(start + entry.turnaroundDaysMax * 86_400_000);
        maxIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
    }

    updateDraft(key, {
      labProvider: entry.provider,
      labPanel: entry.panel,
      expectedResultAtMinIso: minIso,
      expectedResultAtMaxIso: maxIso,
      warning: null,
    });
  }

  const counts = useMemo(() => {
    let ready = 0;
    let needsAttention = 0;
    let willSkip = 0;
    for (const d of drafts) {
      if (d.skipReason) willSkip++;
      else if (
        !d.patientEmail ||
        !d.labProvider ||
        d.matchKind === "ambiguous"
      )
        needsAttention++;
      else ready++;
    }
    return { ready, needsAttention, willSkip };
  }, [drafts]);

  function onCommit() {
    const id = newUuid();
    const acceptable = drafts.filter(
      (d) => !d.skipReason && d.patientEmail && d.labProvider,
    );
    if (acceptable.length === 0) {
      alert("Nothing to import — every row is skipped or missing required fields.");
      return;
    }
    if (
      !confirm(
        `Import ${acceptable.length} case(s)? This stamps a bulk_import_id you can use to roll back.`,
      )
    )
      return;

    setPhase("committing");
    setBulkImportId(id);
    startCommit(async () => {
      const result = await commitImport({
        bulkImportId: id,
        rows: acceptable.map((d) => ({
          patientName: d.patientName,
          patientEmail: d.patientEmail!,
          patientPhone: d.patientPhone,
          patientDobIso: d.patientDobIso,
          labName: d.labProvider!,
          labPanel: d.labPanel,
          trackingNumber: d.trackingNumber,
          sampleSentAtIso: d.sampleSentAtIso,
          expectedResultAtMinIso: d.expectedResultAtMinIso,
          expectedResultAtMaxIso: d.expectedResultAtMaxIso,
          notes: d.notes,
        })),
      });
      if (!result.ok) {
        setCommitMessage(`Import failed: ${result.error}`);
        setPhase("preview");
        return;
      }
      const { insertedCount, failed } = result.data!;
      const failTail =
        failed.length > 0
          ? ` · ${failed.length} failed (${failed.slice(0, 3).map((f) => f.patientName).join(", ")}${failed.length > 3 ? "…" : ""})`
          : "";
      setCommitMessage(
        `Imported ${insertedCount} case${insertedCount === 1 ? "" : "s"}.${failTail}`,
      );
      setPhase("done");
    });
  }

  if (phase === "upload") {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
          <h2 className="text-base font-semibold text-zinc-900">
            Upload Lab Shipping CSV
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Expects the canonical &ldquo;Lab Shipping - Main.csv&rdquo; format
            (Date, Carrier, Service Level, tracking #, Confirmation #, Shipper,
            Recipient, Patients, Contents, Date Shipped, Notes).
          </p>
          <label className="mt-6 inline-block cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800">
            Choose CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
          <p className="mt-4 text-[11px] text-zinc-400">
            Only rows dated in {TARGET_YEAR} will be imported.
          </p>
        </div>

        <RollbackByIdSection />
      </div>
    );
  }

  if (phase === "done") {
    function onRollback() {
      if (!bulkImportId) return;
      if (
        !confirm(
          `Soft-delete every case from this import?\n\nID: ${bulkImportId}\n\nThe rows are recoverable from /labs/deleted, but they'll disappear from the kanban.`,
        )
      )
        return;
      startRollback(async () => {
        const r = await rollbackImport(bulkImportId);
        if (!r.ok) {
          setRollbackMessage(`Rollback failed: ${r.error}`);
          return;
        }
        setRollbackMessage(
          `Rolled back ${r.data?.deletedCount ?? 0} case(s). They're now in /labs/deleted.`,
        );
      });
    }

    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-8">
        <h2 className="text-base font-semibold text-zinc-900">Import complete</h2>
        <p className="mt-2 text-sm text-zinc-700">{commitMessage}</p>
        {bulkImportId ? (
          <p className="mt-2 text-[11px] text-zinc-400">
            Bulk import ID:{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5">{bulkImportId}</code>
          </p>
        ) : null}
        {rollbackMessage ? (
          <p className="mt-3 rounded bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
            {rollbackMessage}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href="/labs"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            View kanban
          </a>
          <button
            type="button"
            onClick={() => {
              setPhase("upload");
              setDrafts([]);
              setParseStats(null);
              setCommitMessage(null);
              setBulkImportId(null);
              setRollbackMessage(null);
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            Import another file
          </button>
          {bulkImportId ? (
            <button
              type="button"
              onClick={onRollback}
              className="ml-auto rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Rollback this import
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-700">
          {parseStats ? (
            <>
              <span>{parseStats.totalDataRows} CSV data rows</span>
              <span>{parseStats.inYearRows} in {TARGET_YEAR}</span>
              <span>{parseStats.draftCount} after multi-patient split</span>
            </>
          ) : null}
          <span className="ml-auto flex items-center gap-3">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">
              Ready: {counts.ready}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
              Needs attention: {counts.needsAttention}
            </span>
            <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-zinc-700">
              Skip: {counts.willSkip}
            </span>
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-left text-zinc-600">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Patient</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Lab</th>
              <th className="px-3 py-2 font-medium">Tracking</th>
              <th className="px-3 py-2 font-medium">Sample sent</th>
              <th className="px-3 py-2 font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr
                key={d.draftKey}
                className={`border-t border-zinc-100 ${d.skipReason ? "bg-zinc-50/60 text-zinc-400" : ""}`}
              >
                <td className="px-3 py-2 align-top text-zinc-400">
                  {d.sourceRowNum}
                </td>
                <td className="px-3 py-2 align-top">
                  <input
                    value={d.patientName}
                    onChange={(e) =>
                      updateDraft(d.draftKey, { patientName: e.target.value })
                    }
                    disabled={!!d.skipReason}
                    className="w-44 rounded border border-zinc-200 bg-white px-2 py-1 text-zinc-900"
                  />
                  {d.matchKind === "ambiguous" && d.candidates.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.candidates.map((c) => (
                        <button
                          key={c.recordId}
                          type="button"
                          onClick={() => pickCandidate(d.draftKey, c)}
                          className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100"
                          title={c.email ?? "no email"}
                        >
                          {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <input
                    value={d.patientEmail ?? ""}
                    onChange={(e) =>
                      updateDraft(d.draftKey, {
                        patientEmail: e.target.value || null,
                      })
                    }
                    disabled={!!d.skipReason}
                    placeholder="—"
                    className="w-56 rounded border border-zinc-200 bg-white px-2 py-1 text-zinc-900"
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <select
                    value={
                      d.labProvider
                        ? // Reverse-find a catalog entry by provider+panel
                          (LAB_CATALOG.find(
                            (e) =>
                              e.provider === d.labProvider &&
                              (e.panel ?? "") === (d.labPanel ?? ""),
                          )?.name ?? "")
                        : ""
                    }
                    onChange={(e) =>
                      setLabFromCatalogName(d.draftKey, e.target.value)
                    }
                    disabled={!!d.skipReason}
                    className="w-52 rounded border border-zinc-200 bg-white px-2 py-1 text-zinc-900"
                  >
                    <option value="">— pick lab —</option>
                    {LAB_CATALOG.map((e) => (
                      <option key={e.name} value={e.name}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  {d.rawCarrier ? (
                    <p className="mt-0.5 text-[10px] text-zinc-400">
                      raw: {d.rawCarrier}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="font-mono text-[11px] text-zinc-700">
                    {d.trackingNumber || "—"}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-zinc-700">
                  {d.sampleSentAtIso ?? "—"}
                </td>
                <td className="px-3 py-2 align-top text-zinc-700">
                  {d.expectedResultAtMinIso || d.expectedResultAtMaxIso
                    ? `${d.expectedResultAtMinIso ?? "—"} → ${d.expectedResultAtMaxIso ?? "—"}`
                    : "—"}
                </td>
                <td className="px-3 py-2 align-top">
                  {d.skipReason ? (
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
                      skip · {d.skipReason}
                    </span>
                  ) : !d.patientEmail || !d.labProvider ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">
                      {d.warning ?? "needs fields"}
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">
                      ready
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          Skipped rows are dropped on import. Amber rows can still be imported
          if you fill the missing email or lab.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPhase("upload");
              setDrafts([]);
              setParseStats(null);
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={phase === "committing" || counts.ready === 0}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {phase === "committing"
              ? "Importing…"
              : `Import ${counts.ready} ready row${counts.ready === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {commitMessage ? (
        <p className="text-xs text-red-600">{commitMessage}</p>
      ) : null}
    </div>
  );
}
