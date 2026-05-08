-- Synced mirror of PracticeBetter's /consultant/records list. Used as a fast,
-- indexed lookup so the push action doesn't paginate the live PB API on every
-- click. Refreshed by the syncPracticeBetterClients server action.

create table if not exists practicebetter_clients (
  record_id        text primary key,
  email_lowered    text,
  first_name       text,
  last_name        text,
  status           text,
  is_child_record  boolean,
  raw              jsonb,
  last_synced_at   timestamptz not null default now()
);

create index if not exists practicebetter_clients_email_idx
  on practicebetter_clients (email_lowered);

alter table practicebetter_clients enable row level security;

-- Tracks each sync run for visibility ("last sync at 3:45pm — 1,363 records, 14 pages").
create table if not exists practicebetter_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  records_seen    integer not null default 0,
  pages_seen      integer not null default 0,
  variant_used    text,            -- which query-param variant succeeded ('default' | 'details' | 'child_false')
  stopped_early   boolean not null default false,
  error_message   text,
  diagnostics     jsonb
);

alter table practicebetter_sync_runs enable row level security;
