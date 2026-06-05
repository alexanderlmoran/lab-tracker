// "Effective" lab catalog layer — merges the editable labs_catalog DB rows
// over the code-defined LAB_CATALOG. Database wins for fields it can express
// (turnaround days, retired flag, panel, provider, notes). Aliases stay in
// code because CSV import normalisation reads them synchronously and they're
// tightly coupled to parsing logic.
//
// Use these helpers from server code paths that affect patient communication
// or workflow predictions (email turnaround text, step-1 result date estimate,
// the lab combobox dropdown). The plain code-only `findLabByName` from
// catalog.ts is still correct for CSV-import normalisation where aliases
// matter more than turnaround.

import { getSupabaseAdmin } from "@/utils/supabase/admin";
import {
  LAB_CATALOG,
  findLabByName,
  normalizeLabKey,
  type LabCatalogEntry,
} from "./catalog";

type DbRow = {
  id: string;
  name: string;
  provider: string;
  panel: string | null;
  turnaround_days_min: number | null;
  turnaround_days_max: number | null;
  retired: boolean;
  partial_expected: boolean;
  notes: string | null;
};

function rowToEntry(row: DbRow): LabCatalogEntry {
  // DB rows don't carry aliases — when there's a code entry with the same
  // canonical name we splice its aliases through so import paths that look
  // up effective entries still match alternative spellings.
  const codeMatch = LAB_CATALOG.find((e) => e.name === row.name);
  return {
    name: row.name,
    provider: row.provider,
    panel: row.panel,
    turnaroundDaysMin: row.turnaround_days_min,
    turnaroundDaysMax: row.turnaround_days_max,
    retired: row.retired || undefined,
    partialExpected: row.partial_expected || undefined,
    aliases: codeMatch?.aliases,
  };
}

async function loadDbCatalog(): Promise<DbRow[]> {
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("labs_catalog")
      .select(
        "id, name, provider, panel, turnaround_days_min, turnaround_days_max, retired, partial_expected, notes",
      );
    return (data ?? []) as DbRow[];
  } catch {
    // Table may not exist yet (pre-migration) — fall back silently to code.
    return [];
  }
}

/** Per-request memo so a single render doesn't fan out N db queries. */
let cache: { at: number; rows: DbRow[] } | null = null;
const CACHE_TTL_MS = 5_000;

async function getDbRowsCached(): Promise<DbRow[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await loadDbCatalog();
  cache = { at: now, rows };
  return rows;
}

/** Force the next call to re-read from DB. Call from settings mutations so
 * the editor's changes show up immediately on subsequent requests. */
export function invalidateEffectiveCatalogCache() {
  cache = null;
}

/** DB-overlay lookup. Returns the effective entry, preferring a DB row
 * matched by canonical name when present and falling back to the code
 * catalog's alias-aware `findLabByName` otherwise. */
export async function getEffectiveLab(
  raw: string,
): Promise<LabCatalogEntry | null> {
  if (!raw) return null;
  const codeEntry = findLabByName(raw);
  const rows = await getDbRowsCached();
  if (rows.length === 0) return codeEntry;

  // Match DB row by code-entry name first (handles alias hits), then by raw.
  const byName = new Map(rows.map((r) => [normalizeLabKey(r.name), r]));
  const dbRow =
    (codeEntry && byName.get(normalizeLabKey(codeEntry.name))) ??
    byName.get(normalizeLabKey(raw));
  if (dbRow) return rowToEntry(dbRow);
  return codeEntry;
}

/** Effective list for the combobox: every DB row + code entries that have
 * no DB twin. Retired entries last; otherwise sorted by name.
 *
 * Dedup is by NORMALIZED key (normalizeLabKey), not raw name — otherwise the
 * same lab present in both the DB catalog and the code catalog with any
 * spelling/case/whitespace difference ("Access" vs "Access ", "Peptides" vs
 * "peptides") shows up TWICE in the dropdown. DB rows win (they're the editable
 * overlay); the first row for a given key is kept. */
export async function listEffectiveLabs(): Promise<LabCatalogEntry[]> {
  const rows = await getDbRowsCached();
  const out: LabCatalogEntry[] = [];
  const seen = new Set<string>();
  // DB rows first (editable overlay wins); collapse duplicate DB rows too.
  for (const r of rows) {
    const key = normalizeLabKey(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rowToEntry(r));
  }
  // Code entries only when no DB twin shares the normalized key.
  for (const code of LAB_CATALOG) {
    const key = normalizeLabKey(code.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  out.sort((a, b) => {
    const aRet = a.retired ? 1 : 0;
    const bRet = b.retired ? 1 : 0;
    if (aRet !== bRet) return aRet - bRet;
    return a.name.localeCompare(b.name);
  });
  return out;
}
