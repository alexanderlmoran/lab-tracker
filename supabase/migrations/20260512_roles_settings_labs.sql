-- Phase A — Roles, app settings, and DB-backed lab catalog (idempotent).
-- 2026-05-12.
--
-- Written defensively: every statement is safe to re-run after a partial
-- failure (e.g. if the type was created but a later table errored). Use
-- `create ... if not exists` for objects that support it, and a DO block
-- for the enum type which does not.

-- ── Roles ──────────────────────────────────────────────────────────────
-- Three-tier RBAC. `developer` is the superuser (can manage admins).
-- `admin` can manage staff + edit settings/labs. `staff` is everyone else
-- (Nadia, Allison, Chris) — can use the kanban + inbox but not settings.

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'app_role'
  ) then
    create type app_role as enum ('developer', 'admin', 'staff');
  end if;
end $$;

create table if not exists app_users (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  full_name   text,
  role        app_role not null default 'staff',
  invited_by  uuid references auth.users (id) on delete set null,
  invited_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists app_users_role_idx on app_users (role);

drop trigger if exists set_app_users_updated_at on app_users;
create trigger set_app_users_updated_at
  before update on app_users
  for each row execute function set_updated_at();

alter table app_users enable row level security;
-- Reads are admin-only via the service-role key on the server. No public
-- RLS policies needed (the secret key bypasses RLS).

-- ── App settings (key/value) ──────────────────────────────────────────
-- Free-form text store for runtime-editable config (reply-to email,
-- sending-from email, etc.). Hardcoded defaults still live in env so a
-- missing row falls back gracefully.

create table if not exists app_settings (
  key         text primary key,
  value       text,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_app_settings_updated_at on app_settings;
create trigger set_app_settings_updated_at
  before update on app_settings
  for each row execute function set_updated_at();

alter table app_settings enable row level security;

-- ── DB-backed lab catalog ──────────────────────────────────────────────
-- Mirror of src/lib/labs/catalog.ts. Aliases stay code-driven (CSV import
-- normalization is too entangled with parsing to make runtime-editable
-- safely) but turnaround days, retired flag, and add/remove are editable.
-- The lookup helper falls back to the code catalog if the row is missing.

create table if not exists labs_catalog (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null unique,
  provider               text not null,
  panel                  text,
  turnaround_days_min    integer,
  turnaround_days_max    integer,
  retired                boolean not null default false,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists labs_catalog_provider_idx on labs_catalog (provider);
create index if not exists labs_catalog_retired_idx on labs_catalog (retired);

drop trigger if exists set_labs_catalog_updated_at on labs_catalog;
create trigger set_labs_catalog_updated_at
  before update on labs_catalog
  for each row execute function set_updated_at();

alter table labs_catalog enable row level security;
