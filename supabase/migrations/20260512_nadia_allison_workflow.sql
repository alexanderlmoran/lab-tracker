-- Workflow expansion 2026-05-12:
-- 1) Nadia "all labs received" click-to-confirm email per patient.
-- 2) Allison ROF proofread email when step 6 (rof_scheduled) is ticked,
--    which also auto-completes step 9 (relabeled to "ROF Allison email sent").

-- New email kinds. Postgres requires `add value` outside a tx block; supabase
-- runs each statement separately so this is fine.
alter type email_kind add value if not exists 'nadia_all_received';
alter type email_kind add value if not exists 'rof_allison';

-- Per-case Nadia/Allison tracking columns.
alter table lab_cases
  add column if not exists nadia_confirm_token       text,
  add column if not exists nadia_confirm_sent_at     timestamptz,
  add column if not exists nadia_confirmed_at        timestamptz,
  add column if not exists allison_rof_emailed_at    timestamptz;

-- A single token may reference many cases (one patient with N labs). The
-- token is generated once when the last lab hits step 5 and stamped on
-- every sibling case in the same batch.
create index if not exists lab_cases_nadia_confirm_token_idx
  on lab_cases (nadia_confirm_token)
  where nadia_confirm_token is not null;
