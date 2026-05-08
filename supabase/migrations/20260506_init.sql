-- Lab Tracker initial schema.
-- Run this in Supabase Studio → SQL Editor, or via `supabase db push`.

create extension if not exists pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────

create type email_kind as enum (
  'sample_sent',        -- Email 1 — step 1
  'partial_uploaded',   -- Email 2 — step 3
  'complete_uploaded',  -- Email 3 — step 5
  'rof_followup'        -- Email 4 — step 7
);

create type email_status as enum (
  'queued',
  'sent',
  'failed',
  'skipped'
);

create type lab_event_kind as enum (
  'step_toggled',
  'case_created',
  'case_edited',
  'case_archived',
  'case_unarchived',
  'email_sent',
  'email_failed',
  'email_skipped'
);

-- ── Tables ───────────────────────────────────────────────────────────

create table lab_cases (
  id                       uuid primary key default gen_random_uuid(),
  patient_name             text not null,
  patient_email            text not null,
  patient_phone            text,
  patient_dob              date,
  patient_address          text,
  lab_name                 text not null,
  lab_panel                text,
  tracking_number          text,
  partial_expected         boolean not null default false,
  auto_send_emails         boolean not null default true,
  notes                    text,

  step1_sample_sent        boolean not null default false,
  step2_partial_received   boolean not null default false,
  step3_partial_uploaded   boolean not null default false,
  step4_complete_received  boolean not null default false,
  step5_complete_uploaded  boolean not null default false,
  step6_rof_scheduled      boolean not null default false,
  step7_rof_completed      boolean not null default false,
  step8_protocol_emailed   boolean not null default false,
  step9_sales_followup     boolean not null default false,

  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index lab_cases_archived_at_idx on lab_cases (archived_at);
create index lab_cases_patient_email_idx on lab_cases (patient_email);

create table lab_events (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references lab_cases (id) on delete cascade,
  kind        lab_event_kind not null default 'step_toggled',
  step        smallint,
  completed   boolean,
  actor       text not null default 'admin',
  note        text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index lab_events_case_id_created_at_idx
  on lab_events (case_id, created_at desc);

create table email_logs (
  id                 uuid primary key default gen_random_uuid(),
  case_id            uuid not null references lab_cases (id) on delete cascade,
  kind               email_kind not null,
  status             email_status not null default 'queued',
  resend_message_id  text,
  to_address         text not null,
  error_message      text,
  created_at         timestamptz not null default now(),

  unique (case_id, kind)
);

create index email_logs_case_id_idx on email_logs (case_id);

-- ── updated_at trigger ───────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger lab_cases_set_updated_at
before update on lab_cases
for each row execute function set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
-- The internal admin tool talks to Postgres exclusively via the secret
-- key (server-side, bypasses RLS). Enable RLS so the publishable key
-- exposed in the browser cannot read any rows.

alter table lab_cases  enable row level security;
alter table lab_events enable row level security;
alter table email_logs enable row level security;
-- No policies = deny all for non-secret-key clients. Server admin client
-- (using SUPABASE_SECRET_KEY) bypasses these checks.
