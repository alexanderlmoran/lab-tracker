-- Engine & posting metrics — time-series the worker writes so the Analytics
-- "Engine" tab can show live PB-coverage % and per-reconcile-cycle history
-- (auto-posted / flagged / errors over time), not just a point-in-time snapshot.
--
-- Written by the Fly worker via tracker endpoints (/api/worker/engine-run and
-- /api/worker/coverage-snapshot), read by the Next Analytics page through the
-- service-role admin client. Both are service-role-only (RLS on, no policies) —
-- lab_audit_runs.gaps embeds patient names, so it must never be anon-readable.

-- One row per reconcile cycle.
create table if not exists lab_engine_runs (
  id          uuid primary key default gen_random_uuid(),
  ran_at      timestamptz not null default now(),
  lab         text,                              -- 'all' or a specific lab key
  mode        text not null default 'apply',     -- 'apply' | 'dry'
  advanced    integer not null default 0,        -- already-on-PB silent advances
  autoposted  integer not null default 0,        -- grade ≥ threshold → posted
  flagged     integer not null default 0,        -- staged, flagged for review
  searching   integer not null default 0,        -- no candidate found this pass
  errors      integer not null default 0,
  details     jsonb                              -- optional per-lab breakdown, etc.
);
create index if not exists lab_engine_runs_ran_at_idx on lab_engine_runs (ran_at desc);

-- One row per PB-coverage audit snapshot.
create table if not exists lab_audit_runs (
  id           uuid primary key default gen_random_uuid(),
  ran_at       timestamptz not null default now(),
  total        integer not null default 0,
  strong       integer not null default 0,       -- accession verified on chart
  likely       integer not null default 0,       -- vendor + date matched on chart
  missing      integer not null default 0,
  no_match     integer not null default 0,       -- patient not matched on PB
  coverage_pct numeric,                           -- (strong + likely) / total * 100
  gaps         jsonb                              -- [{patient, lab, verdict}] for drill-down
);
create index if not exists lab_audit_runs_ran_at_idx on lab_audit_runs (ran_at desc);

alter table lab_engine_runs enable row level security;
alter table lab_audit_runs enable row level security;
-- No policies → only the service role (worker via tracker, Next admin client)
-- can read/write. Aggregate metrics + gap lists stay server-side.
