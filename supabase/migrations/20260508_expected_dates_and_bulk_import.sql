-- Phase 7 prep: result-date prediction + bulk-import audit trail.
-- Run this in Supabase Studio → SQL Editor.

-- ── 1. Expected result-date range ───────────────────────────────────
-- Set on step 1 toggle (step1_sample_sent → true) using turnaround
-- estimates from src/lib/labs/catalog.ts. Stored (not derived) so historical
-- accuracy survives later catalog tweaks. Both nullable — many panels have
-- no published turnaround.
alter table lab_cases
  add column if not exists expected_result_at_min date,
  add column if not exists expected_result_at_max date;

create index if not exists lab_cases_expected_result_min_idx
  on lab_cases (expected_result_at_min)
  where expected_result_at_min is not null;

-- ── 2. Bulk-import audit trail ──────────────────────────────────────
-- Each CSV import gets a UUID stamped on every created case so the operator
-- can roll back a bad import (delete where bulk_import_id = ?). Null for
-- cases created via the UI.
alter table lab_cases
  add column if not exists bulk_import_id uuid;

create index if not exists lab_cases_bulk_import_idx
  on lab_cases (bulk_import_id)
  where bulk_import_id is not null;

-- ── 3. New event kinds for the audit log ────────────────────────────
alter type lab_event_kind add value if not exists 'case_bulk_imported';
alter type lab_event_kind add value if not exists 'expected_dates_set';
