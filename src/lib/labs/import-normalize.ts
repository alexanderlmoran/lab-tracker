// Helpers that turn raw "Lab Shipping - Main.csv" rows into draft lab_cases.
// Pure data transforms — no DB access. Server actions wrap these with PB
// matching and persistence.

import { findLabByName, type LabCatalogEntry } from "./catalog";

export type ShippingCsvRow = {
  /** Source row number in the CSV (1-indexed; row 1 is header). */
  rowNum: number;
  date: string;          // col 1 — "5/1/2025"
  carrier: string;       // col 2 — destination lab ("Vibrant", "Cyrex", "Centner", "other"…)
  serviceLevel: string;  // col 3 — "Fedex Express 2 Day"
  trackingNumber: string;// col 4
  confirmationNumber: string; // col 5
  shipperName: string;   // col 6
  recipientName: string; // col 7
  patientsName: string;  // col 8 — may contain multiple, separated by ; or , or "and"
  contents: string;      // col 9
  dateShipped: string;   // col 10 — "05/01/2025" or empty
  notes: string;         // col 11
};

export type ImportSkipReason =
  | "out_of_year"     // Date column not in target year
  | "no_date"         // Date column unparseable
  | "no_patient"     // Patients Name col blank
  | "carrier_centner" // In-house item; user explicitly excluded
  | "carrier_blank";  // Carrier col blank

export type ImportDraft = {
  /** Stable per-row+per-patient identifier used as React key in the preview. */
  draftKey: string;
  sourceRowNum: number;
  /** Patient name as parsed from the CSV (after multi-patient split). */
  patientName: string;
  /** Filled by server-side enrichment via past-patient lookup if available. */
  patientEmail: string | null;
  patientPhone: string | null;
  patientDobIso: string | null;
  /** Carrier as it appeared in the CSV (lowercased). */
  rawCarrier: string;
  /** Resolved catalog provider, when matched. */
  labProvider: string | null;
  /** Resolved catalog panel (always null for shipping CSV — no panel info). */
  labPanel: string | null;
  /** Tracking number, may be empty. */
  trackingNumber: string | null;
  /** Step 1 (sample sent) timestamp anchored to the CSV's Date Shipped (or Date as fallback). */
  sampleSentAtIso: string | null;
  /** Predicted result-date range derived from sample-sent date + catalog turnaround. */
  expectedResultAtMinIso: string | null;
  expectedResultAtMaxIso: string | null;
  /** Notes synthesized from CSV columns the schema doesn't have a home for. */
  notes: string;
  /** Why this row would be skipped on commit. null = good to import. */
  skipReason: ImportSkipReason | null;
  /** Soft warning shown to operator (e.g., "no PB match" or "unrecognized lab"). */
  warning: string | null;
};

export type RawCsvRowsByYear = {
  rows: ShippingCsvRow[];
  totalDataRows: number;
};

const HEADER_ROW_INDEX = 0; // 0-based: header is the first row

/**
 * Parse a CSV table (already split into rows by parseCsv) into ShippingCsvRow
 * objects, filtering by year on the Date column. Drops the header row.
 *
 * The Lab Shipping CSV has 11 named columns; rows with fewer fields are
 * tolerated (defaults to "") so a trailing-comma quirk doesn't break import.
 */
export function extractShippingRowsForYear(
  table: string[][],
  year: number,
): RawCsvRowsByYear {
  const rows: ShippingCsvRow[] = [];
  let totalDataRows = 0;
  for (let i = 0; i < table.length; i++) {
    if (i === HEADER_ROW_INDEX) continue;
    const r = table[i];
    if (!r || r.every((c) => (c ?? "").trim() === "")) continue;
    totalDataRows++;
    const get = (col: number) => (r[col] ?? "").trim();
    const date = get(0);
    const yearOf = parseDate(date)?.getFullYear() ?? null;
    if (yearOf !== year) continue;
    rows.push({
      rowNum: i + 1,
      date,
      carrier: get(1),
      serviceLevel: get(2),
      trackingNumber: get(3),
      confirmationNumber: get(4),
      shipperName: get(5),
      recipientName: get(6),
      patientsName: get(7),
      contents: get(8),
      dateShipped: get(9),
      notes: get(10),
    });
  }
  return { rows, totalDataRows };
}

/**
 * Parse "5/1/2025" or "05/01/2025" or "2025-05-01" into a Date.
 * Returns null when the string isn't recognizable.
 */
export function parseDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  // ISO yyyy-mm-dd
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) {
    const d = new Date(t.slice(0, 10) + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // m/d/yyyy or mm/dd/yyyy
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const month = Number.parseInt(m[1], 10);
    const day = Number.parseInt(m[2], 10);
    const year = Number.parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }
  return null;
}

const ISO = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Split a multi-patient name cell into individual patient names. Source
 * separators we've seen in the wild: ";", " and ", "&", commas (when safe).
 * Empty parts are dropped. Whitespace trimmed.
 *
 * We deliberately don't split on plain commas in single-patient rows like
 * "Smith, John" — the heuristic: only split on comma when the cell contains
 * "; " or " and " (signaling a true list). Otherwise commas stay literal.
 */
export function splitPatientNames(raw: string): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  const looksLikeList = /;|\s+and\s+|&/.test(s);
  if (!looksLikeList) return [s];
  return s
    .split(/;|\s+and\s+|&|,/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const SKIP_CARRIERS = new Set(["centner", "centner labs"]);

/**
 * Build per-patient ImportDrafts from a ShippingCsvRow. Multi-patient cells
 * fan out to multiple drafts. PB matching happens later on the server; this
 * function only handles deterministic transforms.
 */
export function rowToDrafts(row: ShippingCsvRow): ImportDraft[] {
  const carrierRaw = row.carrier.toLowerCase().trim();
  const dateAnchor = parseDate(row.dateShipped) ?? parseDate(row.date);

  const skipReason: ImportSkipReason | null = (() => {
    if (!dateAnchor) return "no_date";
    if (!row.patientsName.trim()) return "no_patient";
    if (!carrierRaw) return "carrier_blank";
    if (SKIP_CARRIERS.has(carrierRaw)) return "carrier_centner";
    return null;
  })();

  // Resolve lab catalog entry (best-effort; "other" and unrecognized fall
  // through to null with a warning so the operator can pick in the preview).
  const catalogEntry = carrierRaw ? findLabByName(carrierRaw) : null;
  let warning: string | null = null;
  if (skipReason === null) {
    if (!catalogEntry) warning = `Unrecognized lab "${row.carrier}" — pick one before import`;
  }

  const labProvider = catalogEntry ? catalogEntry.provider : null;
  const labPanel = null; // shipping CSV never has panel info
  const expected = computeExpected(dateAnchor, catalogEntry);

  // Synthesize notes from columns the schema can't house directly.
  const notesParts: string[] = [];
  if (row.serviceLevel) notesParts.push(`Service: ${row.serviceLevel}`);
  if (row.confirmationNumber) notesParts.push(`Conf #${row.confirmationNumber}`);
  if (row.shipperName) notesParts.push(`Shipped by ${row.shipperName}`);
  if (row.recipientName) notesParts.push(`Recipient: ${row.recipientName}`);
  if (row.contents) notesParts.push(`Contents: ${row.contents}`);
  if (row.notes) notesParts.push(row.notes);
  const synthesizedNotes = notesParts.join(" · ");

  const patientNames = splitPatientNames(row.patientsName);
  if (patientNames.length === 0) {
    return [
      {
        draftKey: `r${row.rowNum}`,
        sourceRowNum: row.rowNum,
        patientName: row.patientsName.trim(),
        patientEmail: null,
        patientPhone: null,
        patientDobIso: null,
        rawCarrier: row.carrier,
        labProvider,
        labPanel,
        trackingNumber: row.trackingNumber || null,
        sampleSentAtIso: dateAnchor ? ISO(dateAnchor) : null,
        expectedResultAtMinIso: expected.minIso,
        expectedResultAtMaxIso: expected.maxIso,
        notes: synthesizedNotes,
        skipReason: skipReason ?? "no_patient",
        warning,
      },
    ];
  }

  return patientNames.map((pn, i) => ({
    draftKey: `r${row.rowNum}-${i}`,
    sourceRowNum: row.rowNum,
    patientName: pn,
    patientEmail: null,
    patientPhone: null,
    patientDobIso: null,
    rawCarrier: row.carrier,
    labProvider,
    labPanel,
    trackingNumber: row.trackingNumber || null,
    sampleSentAtIso: dateAnchor ? ISO(dateAnchor) : null,
    expectedResultAtMinIso: expected.minIso,
    expectedResultAtMaxIso: expected.maxIso,
    notes: synthesizedNotes,
    skipReason,
    warning,
  }));
}

function computeExpected(
  dateAnchor: Date | null,
  entry: LabCatalogEntry | null,
): { minIso: string | null; maxIso: string | null } {
  if (!dateAnchor || !entry) return { minIso: null, maxIso: null };
  const min = entry.turnaroundDaysMin;
  const max = entry.turnaroundDaysMax;
  if (min == null && max == null) return { minIso: null, maxIso: null };
  const start = dateAnchor.getTime();
  const minDate = min != null ? new Date(start + min * 86_400_000) : null;
  const maxDate = max != null ? new Date(start + max * 86_400_000) : null;
  return {
    minIso: minDate ? ISO(minDate) : null,
    maxIso: maxDate ? ISO(maxDate) : null,
  };
}
