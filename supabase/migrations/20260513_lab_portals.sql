-- Editable per-lab portal directory. Mirrors LAB_PORTALS in
-- src/lib/inbound/detect-notification.ts. The code constant stays as the
-- seed source and the runtime fallback when the DB has no row for a lab.
-- 2026-05-13.

create table if not exists lab_portals (
  id          uuid primary key default gen_random_uuid(),
  lab_key     text not null,
  label       text not null,
  url         text not null,
  audience    text,
  sort_order  integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists lab_portals_lab_key_idx on lab_portals (lab_key);

drop trigger if exists set_lab_portals_updated_at on lab_portals;
create trigger set_lab_portals_updated_at
  before update on lab_portals
  for each row execute function set_updated_at();

alter table lab_portals enable row level security;
