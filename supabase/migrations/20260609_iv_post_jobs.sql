-- IV note posting: job queue + template reference registry.
--
-- Mirrors pb_upload_jobs: the app enqueues a post job when a session is charted;
-- the worker (which has the PB Tailscale egress) claims it, grades the
-- patient match (name+DOB+email → 0-100, see match-patient.ts), and either
-- auto-posts the PB session note (score >= 95) or marks it 'held' for review.

-- ── Queue ────────────────────────────────────────────────────────────────
do $$ begin
  create type iv_post_job_status as enum ('queued', 'claimed', 'succeeded', 'failed', 'held');
exception when duplicate_object then null; end $$;

create table if not exists iv_post_jobs (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references iv_sessions (id) on delete cascade,
  status        iv_post_job_status not null default 'queued',
  attempts      integer not null default 0,
  -- Grading outcome (filled by the worker via /result).
  match_score   integer,
  match_reason  text,
  pb_note_id    text,
  pb_client_record_id text,
  last_error    text,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- One live job per session (retry mutates the row, never duplicates).
create unique index if not exists iv_post_jobs_session_uniq on iv_post_jobs (session_id);
create index if not exists iv_post_jobs_status_idx on iv_post_jobs (status)
  where status in ('queued', 'claimed');

-- ── Template reference registry ────────────────────────────────────────────
-- The templates LIST endpoint 425s, so each template's question scaffold is read
-- from a REFERENCE NOTE. Maps a classifier templateHint → one PB note id that
-- used that template. Populate by scanning existing notes (one per IV template).
create table if not exists iv_template_refs (
  template_hint     text primary key,
  reference_note_id text not null,
  note              text,
  updated_at        timestamptz not null default now()
);

alter table iv_post_jobs enable row level security;
alter table iv_template_refs enable row level security;
