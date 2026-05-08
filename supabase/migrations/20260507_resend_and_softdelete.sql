-- Phase 5 prep: allow multiple sends per (case, kind) and soft-delete cases.
-- Run this in Supabase Studio → SQL Editor.

-- ── 1. Drop unique constraint on email_logs ─────────────────────────
-- The (case_id, kind) unique constraint enforced single-send-per-step.
-- We now allow explicit re-sends (e.g. patient lost the email) while
-- keeping all prior log rows for audit.
alter table email_logs drop constraint if exists email_logs_case_id_kind_key;

-- Index to keep "find latest send per (case, kind)" fast.
create index if not exists email_logs_case_kind_created_idx
  on email_logs (case_id, kind, created_at desc);

-- ── 2. New event kinds ──────────────────────────────────────────────
alter type lab_event_kind add value if not exists 'email_resent';
alter type lab_event_kind add value if not exists 'case_deleted';
alter type lab_event_kind add value if not exists 'case_restored';

-- ── 3. Soft-delete column on lab_cases ──────────────────────────────
alter table lab_cases add column if not exists deleted_at timestamptz;
create index if not exists lab_cases_deleted_at_idx
  on lab_cases (deleted_at);
