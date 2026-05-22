-- Phase 0: lab PDFs + approval audit log
--
-- Powers the human-gated upload workflow:
--   1. Worker scraper downloads a PDF, writes a row to lab_case_pdfs.
--   2. UI renders the card in the "Pending Upload" column when a PDF
--      is attached but no terminal audit row exists for it.
--   3. Staff opens the PDF modal → Approve / Wrong PDF / Upload Failed
--      writes a row to lab_case_audit.
--   4. Approve enqueues a PB upload job (separate table, future phase).
--
-- The audit table is append-only via RLS — INSERT only, no UPDATE/DELETE.

-- ── Lab external reference (accession #) ─────────────────────────────
-- Worker code already references this field (worker/src/tracker-client.ts
-- → OpenCase.labExternalRef). Adding the column the worker has been
-- speaking to all along.
alter table lab_cases
  add column if not exists lab_external_ref text;

create index if not exists lab_cases_lab_external_ref_idx
  on lab_cases (lab_external_ref)
  where lab_external_ref is not null;

comment on column lab_cases.lab_external_ref is
  'Lab portal accession / order number. Auto-populated by scraper on first '
  'successful name+DOB match; staff can also enter manually to skip the '
  'matching cascade. When set, scrapers match this case by accession only.';

-- ── PDF attachments ──────────────────────────────────────────────────
create table if not exists lab_case_pdfs (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references lab_cases (id) on delete cascade,
  storage_path    text not null,    -- key in Supabase Storage bucket 'lab-pdfs'
  source          text not null,    -- 'scraper:access', 'manual_upload', 'inbound_email', etc.
  external_ref    text,             -- accession # snapshot at attach-time
  is_partial      boolean not null default false,
  filename        text,
  size_bytes      bigint,
  result_issued_at timestamptz,     -- 'final date' from the lab, when known
  attached_at     timestamptz not null default now(),
  attached_by     text not null default 'worker',  -- 'worker:<scraper>' or user id
  superseded_at   timestamptz,      -- set when a Wrong-PDF disapproval invalidates this row
  superseded_reason text
);

create index if not exists lab_case_pdfs_case_idx
  on lab_case_pdfs (case_id)
  where superseded_at is null;

create index if not exists lab_case_pdfs_external_ref_idx
  on lab_case_pdfs (external_ref)
  where external_ref is not null;

comment on table lab_case_pdfs is
  'PDF attachments per case. A card lives in the "Pending Upload" column '
  'when it has at least one non-superseded PDF and no terminal audit row '
  '(approve / disapprove_wrong_pdf) for that PDF.';

-- ── Approval audit log (append-only) ─────────────────────────────────
create type lab_case_audit_action as enum (
  'approve',                   -- staff approved this PDF; enqueue PB upload
  'disapprove_wrong_pdf',      -- PDF wrong patient / corrupt → re-match needed
  'disapprove_upload_failed',  -- PB upload itself failed (recorded by worker)
  'retry_upload',              -- staff clicked retry after upload failure
  'manual_override',           -- staff edited case state directly
  'accession_edited'           -- staff manually set/changed lab_external_ref
);

create table if not exists lab_case_audit (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references lab_cases (id) on delete cascade,
  pdf_id          uuid references lab_case_pdfs (id) on delete set null,
  action          lab_case_audit_action not null,
  actor_user_id   uuid,                       -- references auth.users; nullable for system
  actor_label     text not null default 'system',  -- 'admin', 'staff:nadia', 'worker:access', etc.
  notes           text,
  meta            jsonb,                      -- e.g. { "old_ref": "...", "new_ref": "..." }
  occurred_at     timestamptz not null default now()
);

create index if not exists lab_case_audit_case_idx
  on lab_case_audit (case_id, occurred_at desc);

create index if not exists lab_case_audit_pdf_idx
  on lab_case_audit (pdf_id)
  where pdf_id is not null;

comment on table lab_case_audit is
  'Append-only audit trail for lab card approval workflow. Required for '
  'medical records compliance. RLS allows INSERT only — no UPDATE/DELETE '
  'policies are defined, so RLS enforcement makes those operations fail.';

-- ── RLS: audit is append-only ────────────────────────────────────────
alter table lab_case_audit enable row level security;

-- Authenticated users (staff) can INSERT and SELECT.
create policy "audit: staff can insert"
  on lab_case_audit for insert
  to authenticated
  with check (true);

create policy "audit: staff can read"
  on lab_case_audit for select
  to authenticated
  using (true);

-- Service role bypasses RLS but stating intent for clarity:
-- - No UPDATE policy → updates fail
-- - No DELETE policy → deletes fail
-- This is intentional. Audit rows are immutable.

-- ── RLS for lab_case_pdfs ────────────────────────────────────────────
alter table lab_case_pdfs enable row level security;

create policy "pdfs: staff can read"
  on lab_case_pdfs for select
  to authenticated
  using (true);

create policy "pdfs: staff can insert"
  on lab_case_pdfs for insert
  to authenticated
  with check (true);

create policy "pdfs: staff can update supersede fields"
  on lab_case_pdfs for update
  to authenticated
  using (true)
  with check (true);

-- NB: PDFs are not hard-deleted via the UI. The worker / admin can delete
-- via service role if needed (e.g. GDPR-style purge).
