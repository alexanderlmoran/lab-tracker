"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { parseCsv } from "@/lib/csv/parse";
import {
  deletePatientSeed,
  listPatientSeedPage,
  searchPatientSeed,
  uploadPatientSeed,
  type PatientSeedListRow,
} from "./actions";

const PAGE_SIZE = 50;

/**
 * Lightweight CSV parser tailored to the seed format. Accepts any column
 * order; matches by header name (case-insensitive, common synonyms).
 * Returns null when required columns are missing. ISO-normalizes DOB.
 */
type SeedDraft = {
  patientName: string;
  email: string;
  phone: string | null;
  dobIso: string | null;
};

// Bound per-request payload size for the upload action. 1500 ~150-byte rows
// fits comfortably under the 8 MB body cap with headroom for overhead. The
// list of all rows still goes through, just split into N sequential calls.
const UPLOAD_BATCH_SIZE = 1500;

function pickColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = norm.indexOf(c.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function normalizeDob(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    let yyyy = us[3];
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 30 ? "19" : "20") + yyyy;
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function parseSeedCsv(text: string): {
  drafts: SeedDraft[];
  errors: string[];
} {
  const table = parseCsv(text);
  if (table.length === 0) return { drafts: [], errors: ["Empty file"] };
  const headers = table[0];

  const fullNameIdx = pickColumn(headers, [
    "patient name",
    "name",
    "full name",
    "guest name",
  ]);
  const firstIdx = pickColumn(headers, ["firstname", "first name", "first"]);
  const lastIdx = pickColumn(headers, ["lastname", "last name", "last"]);
  const emailIdx = pickColumn(headers, ["email", "email address", "e-mail"]);
  const phoneIdx = pickColumn(headers, [
    "phone",
    "phone number",
    "mobile",
    "mobile phone",
    "homephone",
    "home phone",
  ]);
  const dobIdx = pickColumn(headers, ["dob", "date of birth", "birthday"]);

  const hasName = fullNameIdx >= 0 || firstIdx >= 0 || lastIdx >= 0;
  if (!hasName || emailIdx < 0) {
    return {
      drafts: [],
      errors: [
        `Required columns missing. Found headers: ${headers.join(", ")}. Need an email column plus either a name column or FirstName + LastName columns.`,
      ],
    };
  }

  const drafts: SeedDraft[] = [];
  const errors: string[] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    let name = fullNameIdx >= 0 ? (row[fullNameIdx] ?? "").trim() : "";
    if (!name) {
      const f = firstIdx >= 0 ? (row[firstIdx] ?? "").trim() : "";
      const l = lastIdx >= 0 ? (row[lastIdx] ?? "").trim() : "";
      name = [f, l].filter(Boolean).join(" ");
    }
    const email = (row[emailIdx] ?? "").trim();
    if (!name && !email) continue;
    if (name === "-" || name.startsWith("- ") || name.endsWith(" -")) {
      name = name.replace(/(^|\s)-($|\s)/g, " ").trim();
    }
    if (!name) {
      errors.push(`Row ${r + 1}: missing name`);
      continue;
    }
    if (!email || !email.includes("@")) {
      errors.push(`Row ${r + 1} (${name}): invalid email "${email}"`);
      continue;
    }
    drafts.push({
      patientName: name,
      email,
      phone: phoneIdx >= 0 ? (row[phoneIdx] ?? "").trim() || null : null,
      dobIso: dobIdx >= 0 ? normalizeDob(row[dobIdx] ?? "") : null,
    });
  }
  return { drafts, errors };
}

export function PatientSeedPanel({
  initialSample,
  total: initialTotal,
}: {
  initialSample: PatientSeedListRow[];
  total: number;
}) {
  const [total, setTotal] = useState(initialTotal);
  const [pageRows, setPageRows] = useState<PatientSeedListRow[]>(initialSample);
  const [page, setPage] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [drafts, setDrafts] = useState<SeedDraft[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [searchResults, setSearchResults] = useState<PatientSeedListRow[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [, startUpload] = useTransition();
  const [, startDelete] = useTransition();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Debounced server-side search. We never load the whole table client-side
  // because at 27k+ rows the RSC payload blows past Next's 1 MB limit.
  useEffect(() => {
    const q = filter.trim();
    if (q.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const rows = await searchPatientSeed({ query: q });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [filter]);

  // Load the current page of the alphabetical browse when search is off.
  useEffect(() => {
    if (searchResults !== null) return; // search results take over the table
    if (page === 0) return; // page 0 already came in via initialSample
    let cancelled = false;
    setPageLoading(true);
    listPatientSeedPage({ offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((rows) => {
        if (cancelled) return;
        setPageRows(rows);
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, searchResults]);

  async function onFile(file: File) {
    setParseErrors([]);
    setUploadMsg(null);
    const text = await file.text();
    const parsed = parseSeedCsv(text);
    setDrafts(parsed.drafts);
    setParseErrors(parsed.errors);
  }

  function onCommit() {
    if (drafts.length === 0) return;
    const total = drafts.length;
    const batches: SeedDraft[][] = [];
    for (let i = 0; i < total; i += UPLOAD_BATCH_SIZE) {
      batches.push(drafts.slice(i, i + UPLOAD_BATCH_SIZE));
    }
    setUploadProgress({ done: 0, total: batches.length });
    setUploadMsg(null);

    startUpload(async () => {
      let inserted = 0;
      let failed = 0;
      let skipped = 0;
      for (let i = 0; i < batches.length; i++) {
        const r = await uploadPatientSeed({ rows: batches[i], source: "csv_upload" });
        if (!r.ok) {
          setUploadProgress(null);
          setUploadMsg(
            `Upload failed on batch ${i + 1} of ${batches.length}: ${r.error}. ${inserted} rows already saved before the failure.`,
          );
          return;
        }
        inserted += r.data?.inserted ?? 0;
        failed += r.data?.failed ?? 0;
        skipped += r.data?.skipped ?? 0;
        setUploadProgress({ done: i + 1, total: batches.length });
      }
      setUploadProgress(null);
      setUploadMsg(
        `Imported ${inserted} row${inserted === 1 ? "" : "s"}${
          skipped > 0 ? ` · ${skipped} skipped (bad email/format)` : ""
        }${failed > 0 ? ` · ${failed} dropped` : ""}.`,
      );
      setDrafts([]);
      setTotal((prev) => prev + inserted);
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  function onDelete(row: PatientSeedListRow) {
    if (!confirm(`Remove ${row.patientName} (${row.email}) from the seed list?`)) return;
    startDelete(async () => {
      const r = await deletePatientSeed({
        email: row.email,
        patientName: row.patientName,
      });
      if (!r.ok) {
        alert(`Delete failed: ${r.error}`);
        return;
      }
      setTotal((prev) => Math.max(0, prev - 1));
      setPageRows((prev) =>
        prev.filter(
          (r) =>
            !(
              r.email.toLowerCase() === row.email.toLowerCase() &&
              r.patientName === row.patientName
            ),
        ),
      );
      setSearchResults((prev) =>
        prev
          ? prev.filter(
              (r) =>
                !(
                  r.email.toLowerCase() === row.email.toLowerCase() &&
                  r.patientName === row.patientName
                ),
            )
          : prev,
      );
    });
  }

  const visibleRows = searchResults ?? pageRows;
  const showingSearchResults = searchResults !== null;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-zinc-900">Upload seed CSV</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Required: <code>email</code> + either a single name column (
          <code>Name</code>, <code>Guest Name</code>, <code>Full Name</code>)
          or split <code>FirstName</code> + <code>LastName</code> (Centner /
          Zenoti export shape). Optional: <code>phone</code> /{" "}
          <code>mobile</code>, <code>dob</code>. Re-uploading updates rows by
          email — safe to refresh periodically. Large files upload in
          batches of {UPLOAD_BATCH_SIZE.toLocaleString()} rows.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800">
            Choose CSV
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
          {drafts.length > 0 ? (
            <>
              <span className="text-xs text-zinc-600">
                {drafts.length.toLocaleString()} draft row
                {drafts.length === 1 ? "" : "s"} ready
              </span>
              <button
                type="button"
                onClick={onCommit}
                disabled={uploadProgress !== null}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {uploadProgress
                  ? `Uploading batch ${uploadProgress.done}/${uploadProgress.total}…`
                  : "Commit upload"}
              </button>
              <button
                type="button"
                onClick={() => setDrafts([])}
                disabled={uploadProgress !== null}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          ) : null}
        </div>
        {parseErrors.length > 0 ? (
          <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-amber-800">
            {parseErrors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {parseErrors.length > 6 ? (
              <li>… and {parseErrors.length - 6} more</li>
            ) : null}
          </ul>
        ) : null}
        {uploadMsg ? (
          <p className="mt-3 text-xs text-emerald-700">{uploadMsg}</p>
        ) : null}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">
            Seeded patients ({total.toLocaleString()})
          </h3>
          <input
            type="search"
            placeholder="Search by name or email (min 2 chars)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-72 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900"
          />
        </div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
          <span>
            {showingSearchResults
              ? `${visibleRows.length} match${visibleRows.length === 1 ? "" : "es"}${
                  visibleRows.length === 50 ? " (capped at 50 — refine the search)" : ""
                }`
              : `Page ${page + 1} of ${pageCount.toLocaleString()} · showing ${page * PAGE_SIZE + 1}–${Math.min(total, page * PAGE_SIZE + visibleRows.length)} of ${total.toLocaleString()}`}
          </span>
          {!showingSearchResults ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || pageLoading}
                className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1 || pageLoading}
                className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                Next →
              </button>
            </span>
          ) : null}
        </div>
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 text-left text-zinc-600">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">DOB</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {searching || pageLoading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-400">
                    {searching ? "Searching…" : "Loading page…"}
                  </td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-400">
                    {total === 0
                      ? "No seeded patients yet. Upload a CSV above to start."
                      : showingSearchResults
                        ? "No matches."
                        : "—"}
                  </td>
                </tr>
              ) : (
                visibleRows.map((r) => (
                  <tr
                    key={`${r.email}::${r.patientName}`}
                    className="border-t border-zinc-100"
                  >
                    <td className="px-3 py-2 text-zinc-900">{r.patientName}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.email}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.phone ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.dobIso ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onDelete(r)}
                        className="text-rose-700 hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
