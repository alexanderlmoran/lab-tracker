"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { parseCsv } from "@/lib/csv/parse";
import {
  extractShippingRowsForYear,
  parseDate,
  rowToDrafts,
  type ImportDraft,
} from "@/lib/labs/import-normalize";
import {
  detectCentnerFormat,
  extractCentnerRowsForYear,
  centnerRowToDraft,
  type CentnerFormat,
  type CentnerCsvRow,
} from "@/lib/labs/centner-import";
import { saveSalesInvoices } from "../sales/actions";
import { LAB_CATALOG, findLabByName } from "@/lib/labs/catalog";
import {
  aiNormalizeImportDrafts,
  checkImportDuplicates,
  commitImport,
  enrichImportDrafts,
  listRecentImports,
  rollbackImport,
  type DuplicateMatch,
  type EnrichedDraft,
  type PBSuggestion,
  type RecentImport,
} from "./actions";
import type { NormalizeResult } from "@/lib/ai/normalize-import";

const AI_AUTO_APPLY_THRESHOLD = 0.9;

type AiStatus = "idle" | "running" | "done" | "failed" | "skipped";

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

const MIN_YEAR = 2025;

function parseDateToIso(s: string): string | null {
  const d = parseDate(s);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
    sourceFormat: "shipping" | CentnerFormat;
  } | null>(null);
  const [, startEnrich] = useTransition();
  const [, startCommit] = useTransition();
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [bulkImportId, setBulkImportId] = useState<string | null>(null);
  const [rollbackMessage, setRollbackMessage] = useState<string | null>(null);
  const [, startRollback] = useTransition();
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<
    Record<string, NormalizeResult>
  >({});
  const [aiStats, setAiStats] = useState<{
    autoApplied: number;
    needsReview: number;
  }>({ autoApplied: 0, needsReview: 0 });
  const [salesPersistStatus, setSalesPersistStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving"; count: number }
    | { kind: "saved"; count: number }
    | { kind: "failed"; error: string }
  >({ kind: "idle" });
  // Per-draft duplicate classification (server-checked). Filled after the
  // preview phase loads. Rows without an entry are treated as `none`.
  const [dupMap, setDupMap] = useState<Record<string, DuplicateMatch>>({});
  // Per-draft operator decision for duplicates. "skip" = drop on commit
  // (default for any classified duplicate). "import" = pass forceImport=true
  // so the server-side dup check is overridden.
  const [dupDecision, setDupDecision] = useState<Record<string, "skip" | "import">>({});

  async function persistSalesRows(rows: CentnerCsvRow[]) {
    if (rows.length === 0) return;
    setSalesPersistStatus({ kind: "saving", count: rows.length });
    const result = await saveSalesInvoices({
      bulkImportId: null,
      rows: rows.map((r) => ({
        sourceFormat: r.format,
        guestName: r.guestName,
        email: r.email,
        serviceDate: parseDateToIso(r.serviceDate) ?? "",
        invoiceNo: r.invoiceNo || "(none)",
        itemName: r.itemName,
        itemType: r.itemType,
        guestCode: r.guestCode,
        centerCode: r.centerCode,
        centerName: r.centerName,
        itemCode: r.itemCode,
        qty: r.qty,
        salesExTax: r.salesExTax,
        collected: r.collected,
        due: r.due,
        paymentType: r.paymentType,
      })).filter((r) => r.serviceDate),
    });
    if (result.ok) {
      setSalesPersistStatus({ kind: "saved", count: result.data?.insertedOrUpdated ?? 0 });
    } else {
      setSalesPersistStatus({ kind: "failed", error: result.error });
    }
  }

  async function onFile(file: File) {
    const text = await file.text();
    const table = parseCsv(text);

    // Detect Centner format by header signature first; fall back to the
    // canonical Lab Shipping layout if no Centner header is present.
    const centner = detectCentnerFormat(table);

    let localDrafts: ImportDraft[];
    let inYearRows: number;
    let totalDataRows: number;
    let sourceFormat: "shipping" | CentnerFormat;

    if (centner.format != null && centner.headerRowIndex != null) {
      const extracted = extractCentnerRowsForYear(
        table,
        { format: centner.format, headerRowIndex: centner.headerRowIndex },
        { kind: "min", year: MIN_YEAR },
      );
      localDrafts = extracted.rows.map(centnerRowToDraft);
      inYearRows = extracted.rows.length;
      totalDataRows = extracted.totalDataRows;
      sourceFormat = centner.format;

      // Persist raw sales rows to the developer-only viewer table. Fire-and-
      // forget — failures here shouldn't block the lab-case import preview.
      void persistSalesRows(extracted.rows);
    } else {
      const extracted = extractShippingRowsForYear(table, {
        kind: "min",
        year: MIN_YEAR,
      });
      localDrafts = [];
      for (const r of extracted.rows) localDrafts.push(...rowToDrafts(r));
      inYearRows = extracted.rows.length;
      totalDataRows = extracted.totalDataRows;
      sourceFormat = "shipping";
    }

    setParseStats({
      totalDataRows,
      inYearRows,
      draftCount: localDrafts.length,
      sourceFormat,
    });

    startEnrich(async () => {
      const result = await enrichImportDrafts(localDrafts);
      if (!result.ok) {
        alert(`Enrichment failed: ${result.error}`);
        return;
      }
      const enriched = result.data ?? [];
      setDrafts(enriched);
      setPhase("preview");
      // Kick off AI normalization in the background — high-confidence
      // suggestions auto-apply, low-confidence ones surface as inline hints.
      void runAiNormalization(enriched);
      void runDuplicateCheck(enriched);
    });
  }

  // Server-side duplicate classification. Runs against enriched drafts that
  // already have email + lab resolved. Anything still missing required
  // fields is skipped (no point checking — they can't import anyway).
  // Default decision for any flagged duplicate is "skip"; the operator can
  // flip to Import-anyway per row or in bulk.
  async function runDuplicateCheck(enriched: EnrichedDraft[]) {
    const eligible = enriched.filter(
      (d) =>
        !d.skipReason &&
        d.patientEmail &&
        d.labProvider,
    );
    if (eligible.length === 0) return;
    const r = await checkImportDuplicates({
      rows: eligible.map((d) => ({
        patientEmail: d.patientEmail!,
        labName: d.labProvider!,
        labPanel: d.labPanel,
        trackingNumber: d.trackingNumber,
        sampleSentAtIso: d.sampleSentAtIso,
      })),
    });
    if (!r.ok || !r.data) return;
    const nextMap: Record<string, DuplicateMatch> = {};
    const nextDecision: Record<string, "skip" | "import"> = {};
    eligible.forEach((d, i) => {
      const m = r.data![i];
      nextMap[d.draftKey] = m;
      if (m.kind !== "none") nextDecision[d.draftKey] = "skip";
    });
    setDupMap(nextMap);
    setDupDecision((prev) => ({ ...prev, ...nextDecision }));
  }

  async function runAiNormalization(enriched: EnrichedDraft[]) {
    setAiStatus("running");
    setAiError(null);
    const eligible = enriched.filter((d) => !d.skipReason);
    if (eligible.length === 0) {
      setAiStatus("skipped");
      return;
    }
    const r = await aiNormalizeImportDrafts({
      drafts: eligible.map((d) => ({
        draftKey: d.draftKey,
        rawLab: d.rawCarrier,
        patientName: d.patientName,
      })),
    });
    if (!r.ok) {
      setAiStatus("failed");
      setAiError(r.error);
      return;
    }
    const results = r.data ?? [];
    const suggestionMap: Record<string, NormalizeResult> = {};
    let auto = 0;
    let review = 0;

    // Apply high-confidence suggestions; collect the rest for inline review.
    setDrafts((prev) => {
      const next = [...prev];
      for (const res of results) {
        suggestionMap[res.rowKey] = res;
        const i = next.findIndex((d) => d.draftKey === res.rowKey);
        if (i === -1) continue;
        const d = next[i];

        let touched = false;
        const patch: Partial<EnrichedDraft> = {};

        // Patient name: auto-apply if confident and different.
        if (
          res.patientSuggested &&
          res.patientConfidence >= AI_AUTO_APPLY_THRESHOLD &&
          res.patientSuggested !== d.patientName
        ) {
          patch.patientName = res.patientSuggested;
          touched = true;
        }

        // Lab: auto-apply only when the suggestion maps to a known catalog
        // entry. Resolve catalog by provider name (case-insensitive).
        if (
          res.labSuggested &&
          res.labConfidence >= AI_AUTO_APPLY_THRESHOLD
        ) {
          const entry = LAB_CATALOG.find(
            (e) =>
              e.provider.toLowerCase() === res.labSuggested!.toLowerCase(),
          );
          if (entry && entry.provider !== d.labProvider) {
            patch.labProvider = entry.provider;
            patch.labPanel = entry.panel;
            // Recompute expected dates from the auto-applied lab's turnaround.
            if (
              d.sampleSentAtIso &&
              (entry.turnaroundDaysMin != null ||
                entry.turnaroundDaysMax != null)
            ) {
              const start = new Date(
                d.sampleSentAtIso + "T00:00:00",
              ).getTime();
              if (entry.turnaroundDaysMin != null) {
                const dt = new Date(start + entry.turnaroundDaysMin * 86_400_000);
                patch.expectedResultAtMinIso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
              }
              if (entry.turnaroundDaysMax != null) {
                const dt = new Date(start + entry.turnaroundDaysMax * 86_400_000);
                patch.expectedResultAtMaxIso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
              }
            }
            patch.warning = null;
            touched = true;
          }
        }

        if (touched) {
          next[i] = { ...d, ...patch };
          auto++;
        } else if (
          (res.patientSuggested &&
            res.patientConfidence > 0 &&
            res.patientConfidence < AI_AUTO_APPLY_THRESHOLD) ||
          (res.labSuggested &&
            res.labConfidence > 0 &&
            res.labConfidence < AI_AUTO_APPLY_THRESHOLD)
        ) {
          review++;
        }
      }
      return next;
    });

    setAiSuggestions(suggestionMap);
    setAiStats({ autoApplied: auto, needsReview: review });
    setAiStatus("done");
  }

  function acceptAiPatient(key: string) {
    const s = aiSuggestions[key];
    if (!s || !s.patientSuggested) return;
    updateDraft(key, { patientName: s.patientSuggested });
  }

  function acceptAiLab(key: string) {
    const s = aiSuggestions[key];
    if (!s || !s.labSuggested) return;
    const entry = LAB_CATALOG.find(
      (e) => e.provider.toLowerCase() === s.labSuggested!.toLowerCase(),
    );
    if (!entry) return;
    setLabFromCatalogName(key, entry.name);
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
    let dupExact = 0;
    let dupSimilar = 0;
    let dupSkipped = 0;
    for (const d of drafts) {
      const dup = dupMap[d.draftKey];
      if (dup?.kind === "exact") dupExact++;
      else if (dup?.kind === "similar") dupSimilar++;
      const isDupSkipped =
        dup && dup.kind !== "none" && (dupDecision[d.draftKey] ?? "skip") === "skip";
      if (isDupSkipped) dupSkipped++;
      if (d.skipReason) willSkip++;
      else if (
        !d.patientEmail ||
        !d.labProvider ||
        d.matchKind === "ambiguous"
      )
        needsAttention++;
      else if (isDupSkipped) willSkip++;
      else ready++;
    }
    return { ready, needsAttention, willSkip, dupExact, dupSimilar, dupSkipped };
  }, [drafts, dupMap, dupDecision]);

  function onCommit() {
    const id = newUuid();
    const acceptable = drafts.filter((d) => {
      if (d.skipReason || !d.patientEmail || !d.labProvider) return false;
      const dup = dupMap[d.draftKey];
      if (dup && dup.kind !== "none") {
        return (dupDecision[d.draftKey] ?? "skip") === "import";
      }
      return true;
    });
    if (acceptable.length === 0) {
      alert("Nothing to import — every row is skipped, a flagged duplicate, or missing required fields.");
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
          // Operator chose to keep a flagged duplicate — tell the server
          // not to skip it during its own dedup pass.
          forceImport: !!dupMap[d.draftKey] && dupMap[d.draftKey].kind !== "none",
        })),
      });
      if (!result.ok) {
        setCommitMessage(`Import failed: ${result.error}`);
        setPhase("preview");
        return;
      }
      const { insertedCount, failed, skippedDuplicates } = result.data!;
      const failTail =
        failed.length > 0
          ? ` · ${failed.length} failed (${failed.slice(0, 3).map((f) => f.patientName).join(", ")}${failed.length > 3 ? "…" : ""})`
          : "";
      const dupTail =
        skippedDuplicates && skippedDuplicates.length > 0
          ? ` · ${skippedDuplicates.length} duplicate${skippedDuplicates.length === 1 ? "" : "s"} skipped (${skippedDuplicates.slice(0, 3).map((d) => `${d.patientName}/${d.labName}`).join(", ")}${skippedDuplicates.length > 3 ? "…" : ""})`
          : "";
      setCommitMessage(
        `Imported ${insertedCount} case${insertedCount === 1 ? "" : "s"}.${failTail}${dupTail}`,
      );
      setPhase("done");
    });
  }

  if (phase === "upload") {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
          <h2 className="text-base font-semibold text-zinc-900">
            Upload CSV
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Format auto-detected. Accepts: Lab Shipping (Date, Carrier, …),
            Centner guest-sales (Guest Name, Email, Service Date, …), or
            Centner item-sales (Item Type, Sale Date, …).
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
            Only rows dated {MIN_YEAR} or later will be imported. Duplicates
            (matching tracking number, or same patient + lab + collection date)
            are skipped automatically.
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
              <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium uppercase tracking-wide text-zinc-700">
                {parseStats.sourceFormat === "guest-sales"
                  ? "Centner guest-sales"
                  : parseStats.sourceFormat === "item-sales"
                    ? "Centner item-sales"
                    : "Lab Shipping"}
              </span>
              <span>{parseStats.totalDataRows} CSV data rows</span>
              <span>{parseStats.inYearRows} dated {MIN_YEAR}+</span>
              <span>{parseStats.draftCount} draft case{parseStats.draftCount === 1 ? "" : "s"}</span>
              {salesPersistStatus.kind === "saving" ? (
                <span className="text-zinc-500">· Saving sales rows…</span>
              ) : salesPersistStatus.kind === "saved" ? (
                <span className="text-emerald-700">· Saved {salesPersistStatus.count} sales row{salesPersistStatus.count === 1 ? "" : "s"}</span>
              ) : salesPersistStatus.kind === "failed" ? (
                <span className="text-red-700">· Sales save failed: {salesPersistStatus.error}</span>
              ) : null}
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
            {counts.dupExact + counts.dupSimilar > 0 ? (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-800">
                Duplicates: {counts.dupExact + counts.dupSimilar}
                {counts.dupSimilar > 0 ? ` (${counts.dupSimilar} similar)` : ""}
              </span>
            ) : null}
          </span>
        </div>
        {counts.dupExact + counts.dupSimilar > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 text-xs">
            <span className="text-zinc-500">Bulk:</span>
            <button
              type="button"
              onClick={() => {
                setDupDecision((prev) => {
                  const next = { ...prev };
                  for (const d of drafts) {
                    const m = dupMap[d.draftKey];
                    if (m && m.kind !== "none") next[d.draftKey] = "skip";
                  }
                  return next;
                });
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-50"
            >
              Skip all duplicates
            </button>
            <button
              type="button"
              onClick={() => {
                setDupDecision((prev) => {
                  const next = { ...prev };
                  for (const d of drafts) {
                    const m = dupMap[d.draftKey];
                    if (m && m.kind !== "none") next[d.draftKey] = "import";
                  }
                  return next;
                });
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-50"
            >
              Import all duplicates anyway
            </button>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">
              {counts.dupSkipped} of {counts.dupExact + counts.dupSimilar} set to Skip
            </span>
          </div>
        ) : null}
      </div>

      <div
        className={`rounded-md border px-3 py-2 text-xs ${
          aiStatus === "running"
            ? "border-blue-200 bg-blue-50 text-blue-800"
            : aiStatus === "done"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : aiStatus === "failed"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "hidden"
        }`}
      >
        {aiStatus === "running" ? (
          <span>✨ AI normalizing patient & lab names…</span>
        ) : aiStatus === "done" ? (
          <span>
            ✨ AI normalize: <strong>{aiStats.autoApplied}</strong>{" "}
            auto-applied at ≥{Math.round(AI_AUTO_APPLY_THRESHOLD * 100)}%
            confidence · <strong>{aiStats.needsReview}</strong> low-confidence
            suggestions surfaced inline for review.
          </span>
        ) : aiStatus === "failed" ? (
          <span>
            ✨ AI normalize failed ({aiError}). You can still review and import
            manually.
          </span>
        ) : null}
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
                  {(() => {
                    const s = aiSuggestions[d.draftKey];
                    if (
                      !s ||
                      !s.patientSuggested ||
                      s.patientSuggested === d.patientName ||
                      s.patientConfidence >= AI_AUTO_APPLY_THRESHOLD ||
                      s.patientConfidence <= 0
                    ) {
                      return null;
                    }
                    return (
                      <button
                        type="button"
                        onClick={() => acceptAiPatient(d.draftKey)}
                        className="mt-1 inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-800 hover:bg-blue-100"
                        title={s.reason}
                      >
                        ✨ {s.patientSuggested} (
                        {Math.round(s.patientConfidence * 100)}%) ✓
                      </button>
                    );
                  })()}
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
                  {(() => {
                    const s = aiSuggestions[d.draftKey];
                    if (
                      !s ||
                      !s.labSuggested ||
                      s.labConfidence >= AI_AUTO_APPLY_THRESHOLD ||
                      s.labConfidence <= 0 ||
                      s.labSuggested.toLowerCase() ===
                        (d.labProvider ?? "").toLowerCase()
                    ) {
                      return null;
                    }
                    return (
                      <button
                        type="button"
                        onClick={() => acceptAiLab(d.draftKey)}
                        className="mt-1 inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-800 hover:bg-blue-100"
                        title={s.reason}
                      >
                        ✨ {s.labSuggested} (
                        {Math.round(s.labConfidence * 100)}%) ✓
                      </button>
                    );
                  })()}
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
                  {(() => {
                    const dup = dupMap[d.draftKey];
                    const decision = dupDecision[d.draftKey] ?? "skip";
                    if (d.skipReason) {
                      return (
                        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
                          skip · {d.skipReason}
                        </span>
                      );
                    }
                    if (!d.patientEmail || !d.labProvider) {
                      return (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">
                          {d.warning ?? "needs fields"}
                        </span>
                      );
                    }
                    if (dup && dup.kind !== "none") {
                      const label =
                        dup.kind === "exact"
                          ? `duplicate · ${dup.matchedOn === "tracking_number" ? "same tracking" : "same email+lab+date"}`
                          : `similar · same email+lab+panel, different date${dup.existingCollectionDate ? ` (${dup.existingCollectionDate})` : ""}`;
                      return (
                        <div className="flex flex-col gap-1">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                              dup.kind === "exact"
                                ? "bg-rose-100 text-rose-800"
                                : "bg-orange-100 text-orange-800"
                            }`}
                            title={label}
                          >
                            {dup.kind === "exact" ? "duplicate" : "similar"}
                          </span>
                          <p className="text-[10px] text-zinc-500">{label.split(" · ")[1]}</p>
                          <div className="inline-flex overflow-hidden rounded border border-zinc-300 text-[10px]">
                            <button
                              type="button"
                              onClick={() =>
                                setDupDecision((prev) => ({ ...prev, [d.draftKey]: "skip" }))
                              }
                              className={`px-1.5 py-0.5 ${
                                decision === "skip"
                                  ? "bg-zinc-900 text-white"
                                  : "bg-white text-zinc-700 hover:bg-zinc-50"
                              }`}
                            >
                              Skip
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDupDecision((prev) => ({ ...prev, [d.draftKey]: "import" }))
                              }
                              className={`border-l border-zinc-300 px-1.5 py-0.5 ${
                                decision === "import"
                                  ? "bg-zinc-900 text-white"
                                  : "bg-white text-zinc-700 hover:bg-zinc-50"
                              }`}
                            >
                              Import anyway
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">
                        ready
                      </span>
                    );
                  })()}
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
              setDupMap({});
              setDupDecision({});
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
