-- Portal health tracking. One row per portal key (from SCRAPER_REGISTRY).
-- A daily cron probes each login URL and updates these counters; the
-- Scrapers settings panel reads from here to show green/yellow/red badges.
--
-- Two failure thresholds:
--   - 1 consecutive failure: yellow ("portal slow / flaky?")
--   - 2+ consecutive: red ("recalibrate required")
--
-- We treat "consecutive_failures = 0" as healthy regardless of last_check_at
-- age — a portal that hasn't been checked yet just stays neutral.

create table if not exists lab_scraper_status (
  portal_key             text primary key,
  last_check_at          timestamptz,
  last_success_at        timestamptz,
  last_failure_at        timestamptz,
  last_status_code       integer,
  last_error             text,
  consecutive_failures   integer not null default 0,
  updated_at             timestamptz not null default now()
);

create index if not exists lab_scraper_status_failures_idx
  on lab_scraper_status (consecutive_failures desc)
  where consecutive_failures > 0;

drop trigger if exists set_lab_scraper_status_updated_at on lab_scraper_status;
create trigger set_lab_scraper_status_updated_at
  before update on lab_scraper_status
  for each row execute function set_updated_at();

comment on table lab_scraper_status is
  'Per-portal health probed by the daily cron. portal_key matches '
  'SCRAPER_REGISTRY in src/lib/scrapers/registry.ts.';

-- Service role bypasses RLS. Read access for staff so the settings panel works.
alter table lab_scraper_status enable row level security;

create policy "scraper_status: staff can read"
  on lab_scraper_status for select
  to authenticated
  using (true);
