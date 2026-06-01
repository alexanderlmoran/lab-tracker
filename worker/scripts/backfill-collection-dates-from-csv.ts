// Backfill collection_date on tracker cases from "Lab Shipping - Main.csv".
//
// Why: bulk-imported historical rows came in without collection_date. The
// shipping CSV has the ship date + tracking # for every panel that left
// the office, which is the closest ground truth we have to a collection
// date. Join is exact on tracking_number — no fuzziness needed when the
// number is present.
//
// Default is preview (no writes). Add --apply to actually PATCH the cases.
//   cd worker
//   npx tsx scripts/backfill-collection-dates-from-csv.ts                  # Leila, preview
//   npx tsx scripts/backfill-collection-dates-from-csv.ts --apply          # Leila, apply
//   npx tsx scripts/backfill-collection-dates-from-csv.ts --patient=all --apply
//
// --apply uses the write-once `set-collection-date` action on the debug
// PATCH route, which only succeeds if collection_date IS NULL — protects
// real staff-entered dates from being clobbered.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const TRACKER_BASE = process.env.TRACKER_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET;
if (!WORKER_SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const argv = process.argv.slice(2);
const patientArg = argv.find((a) => a.startsWith("--patient="))?.split("=")[1] ?? "leila";
const apply = argv.includes("--apply");

// ── CSV parsing ────────────────────────────────────────────────────────────

type CsvRow = {
  date: string;          // YYYY-MM-DD (best effort)
  carrier: string;       // raw carrier / lab name
  tracking: string;      // normalized (digits/letters, trimmed, upper)
  patientsName: string;  // raw "FIRST LAST, FIRST LAST"
  contents: string;      // raw panel description
  rawLine: number;       // 1-based for diagnostics
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normTracking(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

function toIsoDate(mdy: string): string | null {
  // Accept M/D/YYYY or MM/DD/YYYY (US format). Two-digit year not supported here.
  const m = mdy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function loadShippingCsv(): CsvRow[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const path = resolve(repoRoot, "Lab Shipping - Main.csv");
  const raw = readFileSync(path, "utf-8");
  const all = parseCsv(raw);
  if (all.length === 0) return [];
  const header = all[0].map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.indexOf("date"),
    carrier: header.indexOf("carrier"),
    tracking: header.findIndex((h) => h.replace(/\s+/g, "").startsWith("tracking#")),
    patients: header.indexOf("patients name"),
    contents: header.indexOf("contents"),
  };
  const out: CsvRow[] = [];
  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    if (!r || r.every((v) => !v?.trim())) continue;
    const trackingRaw = (r[idx.tracking] ?? "").trim();
    if (!trackingRaw) continue; // can't join without a tracking #
    const isoDate = toIsoDate(r[idx.date] ?? "") ?? "";
    out.push({
      date: isoDate,
      carrier: (r[idx.carrier] ?? "").trim(),
      tracking: normTracking(trackingRaw),
      patientsName: (r[idx.patients] ?? "").trim(),
      contents: (r[idx.contents] ?? "").trim(),
      rawLine: i + 1,
    });
  }
  return out;
}

function buildTrackingIndex(rows: CsvRow[]): Map<string, CsvRow[]> {
  const map = new Map<string, CsvRow[]>();
  for (const r of rows) {
    const arr = map.get(r.tracking) ?? [];
    arr.push(r);
    map.set(r.tracking, arr);
  }
  return map;
}

// ── Tracker fetch ───────────────────────────────────────────────────────────

type TrackerCase = {
  id: string;
  patient_name: string;
  lab_name: string;
  collection_date: string | null;
  tracking_number: string | null;
  zenoti_appointment_id: string | null;
  step1_sample_sent: boolean;
  step5_complete_uploaded: boolean;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  notes: string | null;
};

async function fetchCases(query: string): Promise<TrackerCase[]> {
  const q = query === "all" ? "" : `q=${encodeURIComponent(query)}&`;
  // limit=all → server paginates the full table (debug GET defaults to 50).
  const url = `${TRACKER_BASE}/api/worker/debug/cases?${q}deleted=null&limit=all`;
  const res = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  if (res.statusCode !== 200) throw new Error(`tracker debug ${res.statusCode}`);
  const json = (await res.body.json()) as { ok: boolean; cases: TrackerCase[] };
  return (json.cases ?? []).filter((c) => !c.archived_at);
}

// ── Patient-name sanity check ──────────────────────────────────────────────

function lastNameFromTracker(name: string): string {
  // e.g. "Leila Centner" → "centner". For "Centner, Leila" too.
  const parts = name.includes(",")
    ? name.split(",")[0].trim().split(/\s+/)
    : name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? "";
  return last.toLowerCase();
}

function patientNameOnCsvRowMatches(trackerName: string, csvNames: string): boolean {
  const ln = lastNameFromTracker(trackerName);
  if (!ln) return false;
  return csvNames.toLowerCase().includes(ln);
}

// ── Main ────────────────────────────────────────────────────────────────────

const log = (m: string = "") => console.log(m);

async function main() {
  log("─".repeat(78));
  log(`CSV → collection_date backfill — ${apply ? "APPLY" : "PREVIEW"}  (patient=${patientArg})`);
  log("─".repeat(78));

  const shipping = loadShippingCsv();
  const trackIdx = buildTrackingIndex(shipping);
  log(`Loaded ${shipping.length} shipping rows; ${trackIdx.size} unique tracking #s.`);

  const cases = await fetchCases(patientArg);
  log(`Pulled ${cases.length} tracker case(s) for "${patientArg}".`);
  log();

  // Buckets for the report.
  const wouldUpdate: Array<{ c: TrackerCase; csv: CsvRow; nameOk: boolean }> = [];
  const ambiguous: Array<{ c: TrackerCase; csvs: CsvRow[] }> = [];
  const noTrackingInCsv: TrackerCase[] = [];
  const skippedNoTracking: TrackerCase[] = [];
  const skippedHasDate: TrackerCase[] = [];

  // Surface duplicate tracker rows that share a tracking #.
  const trackerTrackingCount = new Map<string, number>();
  for (const c of cases) {
    if (!c.tracking_number) continue;
    const k = normTracking(c.tracking_number);
    trackerTrackingCount.set(k, (trackerTrackingCount.get(k) ?? 0) + 1);
  }

  for (const c of cases) {
    if (c.collection_date) { skippedHasDate.push(c); continue; }
    if (!c.tracking_number) { skippedNoTracking.push(c); continue; }
    const key = normTracking(c.tracking_number);
    const matches = trackIdx.get(key) ?? [];
    if (matches.length === 0) { noTrackingInCsv.push(c); continue; }
    if (matches.length > 1) { ambiguous.push({ c, csvs: matches }); continue; }
    const csv = matches[0];
    const nameOk = patientNameOnCsvRowMatches(c.patient_name, csv.patientsName);
    wouldUpdate.push({ c, csv, nameOk });
  }

  // ── Report ────────────────────────────────────────────────────────────
  log("─".repeat(78));
  log(`WOULD UPDATE  (${wouldUpdate.length} cases)  — tracking# matched, date will be set`);
  log("─".repeat(78));
  for (const { c, csv, nameOk } of wouldUpdate) {
    const flag = nameOk ? "✓" : "⚠ name-mismatch";
    log(`  ${flag}  case=${c.id.slice(0, 8)}  ${c.lab_name.padEnd(14)} track=${csv.tracking}`);
    log(`       tracker patient: "${c.patient_name}"`);
    log(`       csv  patient:   "${csv.patientsName}"  carrier="${csv.carrier}" contents="${csv.contents}"`);
    log(`       collection_date:  null  →  ${csv.date}`);
  }

  if (ambiguous.length) {
    log();
    log("─".repeat(78));
    log(`AMBIGUOUS  (${ambiguous.length} cases) — same tracking # in multiple CSV rows`);
    log("─".repeat(78));
    for (const { c, csvs } of ambiguous) {
      log(`  case=${c.id.slice(0, 8)} ${c.lab_name} track=${normTracking(c.tracking_number!)}`);
      for (const r of csvs) log(`    csv L${r.rawLine}: date=${r.date} carrier=${r.carrier} contents="${r.contents}"`);
    }
  }

  if (noTrackingInCsv.length) {
    log();
    log("─".repeat(78));
    log(`TRACKING# NOT IN CSV  (${noTrackingInCsv.length} cases)`);
    log("─".repeat(78));
    for (const c of noTrackingInCsv) {
      log(`  case=${c.id.slice(0, 8)} ${c.lab_name.padEnd(14)} track=${c.tracking_number} (no CSV row)`);
    }
  }

  if (skippedNoTracking.length) {
    log();
    log("─".repeat(78));
    log(`SKIPPED — no tracking# and no collection_date  (${skippedNoTracking.length})`);
    log("─".repeat(78));
    for (const c of skippedNoTracking) {
      log(`  case=${c.id.slice(0, 8)} ${c.lab_name} created=${c.created_at.slice(0, 10)} notes="${(c.notes ?? "").slice(0, 60)}"`);
    }
  }

  // Duplicate detection — same tracking# in tracker more than once.
  const dupes = [...trackerTrackingCount.entries()].filter(([, n]) => n > 1);
  if (dupes.length) {
    log();
    log("─".repeat(78));
    log(`DUPLICATE TRACKER ROWS  (${dupes.length} tracking #s appear >1×)`);
    log("─".repeat(78));
    for (const [k, n] of dupes) {
      const rows = cases.filter((c) => c.tracking_number && normTracking(c.tracking_number) === k);
      log(`  track=${k}  appears ${n}× in tracker:`);
      for (const r of rows) log(`    case=${r.id.slice(0, 8)} lab=${r.lab_name} collected=${r.collection_date ?? "—"} created=${r.created_at.slice(0, 10)}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  log();
  log("─".repeat(78));
  log("SUMMARY");
  log("─".repeat(78));
  log(`  would update collection_date:   ${wouldUpdate.length}`);
  log(`     ↳ with patient-name match:    ${wouldUpdate.filter((x) => x.nameOk).length}`);
  log(`     ↳ patient-name MISMATCH:      ${wouldUpdate.filter((x) => !x.nameOk).length}  (review before applying)`);
  log(`  ambiguous (multi-csv-row):      ${ambiguous.length}`);
  log(`  tracking# not found in csv:     ${noTrackingInCsv.length}`);
  log(`  skipped (no tracking# at all):  ${skippedNoTracking.length}`);
  log(`  skipped (date already set):     ${skippedHasDate.length}`);
  log(`  duplicate tracker rows:         ${dupes.length}`);
  // ── Apply ─────────────────────────────────────────────────────────────
  if (!apply) {
    log();
    log("No writes performed. Re-run with --apply to PATCH these cases.");
    return;
  }

  if (wouldUpdate.length === 0) {
    log();
    log("Nothing to apply.");
    return;
  }

  log();
  log("─".repeat(78));
  log(`APPLYING ${wouldUpdate.length} update(s) via PATCH /api/worker/debug/cases…`);
  log("─".repeat(78));

  let okCount = 0;
  let failCount = 0;
  for (const { c, csv, nameOk } of wouldUpdate) {
    if (!nameOk) {
      log(`  ⚠ skip case=${c.id.slice(0, 8)} — patient-name mismatch, refusing to auto-apply`);
      failCount++;
      continue;
    }
    const url =
      `${TRACKER_BASE}/api/worker/debug/cases` +
      `?id=${encodeURIComponent(c.id)}&action=set-collection-date&date=${encodeURIComponent(csv.date)}`;
    const res = await request(url, {
      method: "PATCH",
      headers: { authorization: `Bearer ${WORKER_SECRET}` },
    });
    const body = (await res.body.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.statusCode === 200 && body.ok) {
      log(`  ✓ case=${c.id.slice(0, 8)} → ${csv.date}`);
      okCount++;
    } else {
      log(`  ✗ case=${c.id.slice(0, 8)} HTTP ${res.statusCode}: ${body.error ?? "unknown"}`);
      failCount++;
    }
  }

  log();
  log(`Applied: ${okCount}  Failed/skipped: ${failCount}`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
