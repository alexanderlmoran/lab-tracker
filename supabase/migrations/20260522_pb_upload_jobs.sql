-- PB upload job queue.
--
-- The "Approve" button in the PDF review modal inserts a row here. A worker
-- poller (worker/scripts/pb-upload-worker.ts) claims queued rows, runs
-- uploadPdfToPb(), and updates status on completion. Decoupling the click
-- from the upload means the UI returns instantly and retries are uniform.

create type pb_upload_job_status as enum (
  'queued',
  'claimed',
  'succeeded',
  'failed'
);

create table if not exists pb_upload_jobs (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references lab_cases (id) on delete cascade,
  pdf_id        uuid not null references lab_case_pdfs (id) on delete cascade,
  status        pb_upload_job_status not null default 'queued',
  attempts      integer not null default 0,
  last_error    text,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Single in-flight or queued job per (case, pdf). On Retry the worker resets
-- a failed row back to 'queued' instead of inserting a duplicate.
create unique index if not exists pb_upload_jobs_case_pdf_uniq
  on pb_upload_jobs (case_id, pdf_id);

create index if not exists pb_upload_jobs_status_idx
  on pb_upload_jobs (status)
  where status in ('queued', 'claimed');

comment on table pb_upload_jobs is
  'Async PB upload queue. Approve action inserts a row; worker poller drains. '
  'Unique on (case_id, pdf_id) so Retry mutates rather than duplicates.';

-- RLS: bypassed by the service role (worker + server actions). Reading from
-- the browser is fine too — staff may want to see queue depth on the modal.
alter table pb_upload_jobs enable row level security;

create policy "pb_upload_jobs: staff can read"
  on pb_upload_jobs for select
  to authenticated
  using (true);
