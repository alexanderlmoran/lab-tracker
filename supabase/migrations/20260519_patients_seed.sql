-- Patient seed list. Pre-populates the CSV import's patient match cache
-- with people who exist in external systems (PracticeBetter export,
-- Zenoti guest list, manually curated rolodex) but haven't had a
-- lab_cases row yet. Lets the importer auto-fill email/phone/DOB on the
-- first lab a patient ever orders, instead of waiting for the second.
--
-- Unique key is the lowercased email — re-uploading a fresher export
-- updates the row in place. `source` distinguishes where the row came
-- from so an export-from-PB doesn't overwrite a hand-edited Zenoti row.
-- 2026-05-19.

create table if not exists patients_seed (
  id              uuid primary key default gen_random_uuid(),
  patient_name    text not null,
  -- Stored lowercased so PostgREST upsert(onConflict: 'email') hits the
  -- unique constraint reliably. Callers must lowercase before insert.
  email           text not null unique,
  phone           text,
  dob             date,
  source          text not null default 'manual' check (source in ('manual', 'practicebetter', 'zenoti', 'csv_upload')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists patients_seed_name_idx
  on patients_seed (patient_name);

drop trigger if exists set_patients_seed_updated_at on patients_seed;
create trigger set_patients_seed_updated_at
  before update on patients_seed
  for each row execute function set_updated_at();

alter table patients_seed enable row level security;
