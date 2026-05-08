-- PracticeBetter integration: store the resolved PB client record id on the
-- case (to avoid re-looking it up by email each push) and audit every push.

alter table lab_cases
  add column if not exists practicebetter_record_id text;

create type practicebetter_push_kind as enum (
  'partial',   -- step 3 (partial_uploaded) — manual button for now
  'complete',  -- step 5 (complete_uploaded) — auto-fires on step toggle
  'manual'     -- ad-hoc push from UI
);

create type practicebetter_push_status as enum (
  'queued',
  'sent',
  'failed',
  'skipped'   -- already-pushed marker present in PB notes
);

create table practicebetter_pushes (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references lab_cases (id) on delete cascade,
  kind            practicebetter_push_kind not null,
  status          practicebetter_push_status not null default 'queued',
  record_id       text,
  marker          text not null,
  notes_appended  boolean not null default false,
  error_message   text,
  attempted_at    timestamptz not null default now(),
  succeeded_at    timestamptz,
  created_at      timestamptz not null default now(),

  unique (case_id, kind)
);

create index practicebetter_pushes_case_id_idx
  on practicebetter_pushes (case_id);

alter table practicebetter_pushes enable row level security;
