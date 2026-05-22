-- Zenoti appointment linkage.
--
-- Adds dedup keys so the Zenoti → tracker sync can be idempotent. When a lab
-- appointment is created in Zenoti, the sync upserts a row in lab_cases keyed
-- by zenoti_appointment_id. Re-running the sync produces no duplicates.
--
-- zenoti_guest_id is indexed separately because it's stable across multiple
-- appointments for the same patient — used to enrich patient details and to
-- handle patients with several labs ordered in one Zenoti visit.

alter table lab_cases
  add column if not exists zenoti_appointment_id text,
  add column if not exists zenoti_guest_id text;

create unique index if not exists lab_cases_zenoti_appointment_id_uniq
  on lab_cases (zenoti_appointment_id)
  where zenoti_appointment_id is not null;

create index if not exists lab_cases_zenoti_guest_id_idx
  on lab_cases (zenoti_guest_id)
  where zenoti_guest_id is not null;

comment on column lab_cases.zenoti_appointment_id is
  'Zenoti appointment UUID. Set when the Zenoti sync auto-creates a case '
  'from a lab appointment. Unique → idempotent re-sync.';
comment on column lab_cases.zenoti_guest_id is
  'Zenoti guest (patient) UUID. Stable across appointments — used for patient '
  'enrichment via GET /api/Guests/<id>.';
