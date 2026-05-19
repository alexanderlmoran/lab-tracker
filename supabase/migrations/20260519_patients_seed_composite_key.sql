-- The initial patients_seed migration keyed on `email` alone, but
-- household/family setups (Centner export) routinely have multiple people
-- sharing one address — a 27k export collapsed to ~1.4k rows because
-- upsert(onConflict: email) only kept the last-seen name per address.
--
-- Switch the uniqueness to a composite (email, patient_name) so siblings,
-- parent/child, and spouses each survive the upsert as distinct rows.
-- Patient-name-only or email-only dupes are still allowed.
-- 2026-05-19.

alter table patients_seed drop constraint if exists patients_seed_email_key;
drop index if exists patients_seed_email_key;
drop index if exists patients_seed_email_name_unique_idx;

-- Use a named CONSTRAINT (not a bare unique index) — PostgREST's upsert
-- onConflict lookup matches by constraint name, not by index.
alter table patients_seed drop constraint if exists patients_seed_email_name_unique;
alter table patients_seed
  add constraint patients_seed_email_name_unique
  unique (email, patient_name);
