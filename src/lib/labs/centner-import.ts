// Centner sales/invoice CSV import.
//
// Two formats supported (auto-detected by header row):
//
//   A) Guest-sales (per-line invoice export):
//      Guest Name | Email | Service Date | Invoice No. | Item Name |
//      Sales (Exc. Tax) | Collected | Due | Payment Type | [Invoice status | ...]
//
//   B) Item-sales (per-item export, no email column):
//      Item Type | Sale Date | Invoice No | Guest Code | Guest Name |
//      Center Code | Center Name | Item Code | Item Name | Qty |
//      Sales (Exc. Tax)
//
// Both formats encode the lab in Item Name (e.g. "Labs - Cyrex",
// "Labs - Access Blood Panel (#2)"). Rows whose Item Name doesn't resolve
// to a lab catalog entry are skipped — these CSVs include non-lab line items
// (packages, peptides, etc.) we don't track here.
//
// Service Date / Sale Date populates collection_date on the resulting lab
// case. That's the bug we're fixing: shipping CSV import has no service date
// so collection_date was ending up null on most cases.

import { findLabByName, type LabCatalogEntry } from "./catalog";
import type { ImportDraft, ImportSkipReason } from "./import-normalize";
import { parseDate } from "./import-normalize";

export type CentnerFormat = "guest-sales" | "item-sales";

export type CentnerCsvRow = {
  rowNum: number;
  format: CentnerFormat;
  guestName: string;
  email: string | null;
  serviceDate: string;
  invoiceNo: string;
  itemName: string;
  salesExTax: string | null;
  collected: string | null;
  due: string | null;
  paymentType: string | null;
  // Item-sales only:
  itemType: string | null;
  guestCode: string | null;
  centerCode: string | null;
  centerName: string | null;
  itemCode: string | null;
  qty: string | null;
};

export type CentnerDetect =
  | { format: CentnerFormat; headerRowIndex: number }
  | { format: null; headerRowIndex: null };

const ISO = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s.#_]+/g, "");
}

/**
 * Find the header row in a table and identify the format. Centner exports
 * commonly have 1-2 junk rows above the header ("Choose Guest" filters,
 * blank rows). Scan the first ~10 rows for a recognizable signature.
 *
 * Signature for guest-sales: header contains "guest name" AND "email" AND
 * "service date" AND "item name".
 *
 * Signature for item-sales: header contains "item type" AND "sale date" AND
 * "guest code" AND "item name".
 */
export function detectCentnerFormat(table: string[][]): CentnerDetect {
  const SCAN_DEPTH = 10;
  for (let i = 0; i < Math.min(SCAN_DEPTH, table.length); i++) {
    const row = (table[i] ?? []).map(norm);
    const set = new Set(row);
    if (
      set.has("guestname") &&
      set.has("email") &&
      set.has("servicedate") &&
      set.has("itemname")
    ) {
      return { format: "guest-sales", headerRowIndex: i };
    }
    if (
      set.has("itemtype") &&
      set.has("saledate") &&
      set.has("guestcode") &&
      set.has("itemname")
    ) {
      return { format: "item-sales", headerRowIndex: i };
    }
  }
  return { format: null, headerRowIndex: null };
}

function buildHeaderIndex(headerRow: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    const key = norm(h);
    if (key && idx[key] == null) idx[key] = i;
  });
  return idx;
}

export type CentnerExtractResult = {
  format: CentnerFormat;
  rows: CentnerCsvRow[];
  totalDataRows: number;
};

/**
 * Pull data rows from a detected Centner table. Filters by year on the
 * Service Date / Sale Date column (same `min`/`exact` semantics as the
 * Lab Shipping importer).
 *
 * Skips blank rows, "Key" sentinel rows the export prepends, and rows whose
 * date can't be parsed.
 */
export function extractCentnerRowsForYear(
  table: string[][],
  detect: { format: CentnerFormat; headerRowIndex: number },
  filter: { kind: "exact" | "min"; year: number },
): CentnerExtractResult {
  const header = table[detect.headerRowIndex] ?? [];
  const idx = buildHeaderIndex(header);
  const rows: CentnerCsvRow[] = [];
  let totalDataRows = 0;

  const get = (r: string[], key: string): string => {
    const i = idx[key];
    if (i == null) return "";
    return (r[i] ?? "").trim();
  };

  for (let i = detect.headerRowIndex + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || r.every((c) => (c ?? "").trim() === "")) continue;

    // Centner exports sometimes include a "Key" sentinel row directly after
    // the header. Detect it by the absence of expected data fields.
    const guestName = get(r, "guestname");
    const itemName = get(r, "itemname");
    if (!guestName && !itemName) continue;

    totalDataRows++;
    const dateStr =
      detect.format === "guest-sales"
        ? get(r, "servicedate")
        : get(r, "saledate");
    const date = parseDate(dateStr);
    if (!date) continue;
    if (filter.kind === "exact" && date.getFullYear() !== filter.year) continue;
    if (filter.kind === "min" && date.getFullYear() < filter.year) continue;

    rows.push({
      rowNum: i + 1,
      format: detect.format,
      guestName,
      email: get(r, "email") || null,
      serviceDate: dateStr,
      invoiceNo: get(r, "invoiceno") || get(r, "invoiceno."),
      itemName,
      salesExTax: get(r, "salesexctax") || null,
      collected: get(r, "collected") || null,
      due: get(r, "due") || null,
      paymentType: get(r, "paymenttype") || null,
      itemType: get(r, "itemtype") || null,
      guestCode: get(r, "guestcode") || null,
      centerCode: get(r, "centercode") || null,
      centerName: get(r, "centername") || null,
      itemCode: get(r, "itemcode") || null,
      qty: get(r, "qty") || null,
    });
  }

  return { format: detect.format, rows, totalDataRows };
}

/**
 * Strip the duplicate marker "(#2)", "(#3)", … off an Item Name so it
 * matches the catalog. These are line-item disambiguators in Centner's
 * billing system (same lab ordered twice on one invoice) and don't change
 * the underlying lab.
 */
function stripDuplicateMarker(s: string): string {
  return s.replace(/\s*\(#\d+\)\s*$/i, "").trim();
}

function computeExpected(
  dateAnchor: Date,
  entry: LabCatalogEntry | null,
): { minIso: string | null; maxIso: string | null } {
  if (!entry) return { minIso: null, maxIso: null };
  const start = dateAnchor.getTime();
  return {
    minIso:
      entry.turnaroundDaysMin != null
        ? ISO(new Date(start + entry.turnaroundDaysMin * 86_400_000))
        : null,
    maxIso:
      entry.turnaroundDaysMax != null
        ? ISO(new Date(start + entry.turnaroundDaysMax * 86_400_000))
        : null,
  };
}

/**
 * Convert one Centner CSV row to an ImportDraft. Unlike the Lab Shipping
 * importer, rows here are one-patient-per-row — no multi-patient fanning.
 *
 * Skip rules:
 *   • no date → no_date
 *   • no guest name → no_patient
 *   • item name doesn't resolve to a lab catalog entry → skipped via
 *     `skipReason: "not_a_lab"` (we surface count in the preview; user can
 *     drop them).
 */
export function centnerRowToDraft(row: CentnerCsvRow): ImportDraft {
  const date = parseDate(row.serviceDate);
  const cleanedItem = stripDuplicateMarker(row.itemName);
  const catalogEntry = cleanedItem ? findLabByName(cleanedItem) : null;

  const skipReason: ImportSkipReason | null = (() => {
    if (!date) return "no_date";
    if (!row.guestName) return "no_patient";
    if (!catalogEntry) return "not_a_lab";
    return null;
  })();

  const labProvider = catalogEntry?.provider ?? null;
  const labPanel = catalogEntry?.panel ?? null;
  const expected = date
    ? computeExpected(date, catalogEntry)
    : { minIso: null, maxIso: null };

  const notesParts: string[] = [];
  if (row.invoiceNo) notesParts.push(`Invoice ${row.invoiceNo}`);
  if (row.salesExTax) notesParts.push(`Sales ${row.salesExTax}`);
  if (row.paymentType) notesParts.push(row.paymentType);
  if (row.format === "item-sales") {
    if (row.itemCode) notesParts.push(`Item ${row.itemCode}`);
    if (row.qty) notesParts.push(`Qty ${row.qty}`);
    if (row.centerName) notesParts.push(row.centerName);
  }
  const notes = notesParts.join(" · ");

  let warning: string | null = null;
  if (skipReason == null && !row.email && row.format === "guest-sales") {
    warning = "Missing email — fill in before import";
  }
  if (skipReason == null && row.format === "item-sales") {
    warning = "Item-sales format has no email column — fill in before import";
  }

  return {
    draftKey: `c${row.rowNum}`,
    sourceRowNum: row.rowNum,
    patientName: row.guestName,
    patientEmail: row.email,
    patientPhone: null,
    patientDobIso: null,
    rawCarrier: cleanedItem || row.itemName,
    labProvider,
    labPanel,
    trackingNumber: null,
    sampleSentAtIso: date ? ISO(date) : null,
    expectedResultAtMinIso: expected.minIso,
    expectedResultAtMaxIso: expected.maxIso,
    notes,
    skipReason,
    warning,
  };
}
