-- Persist the raw Zenoti service name on lab_cases so downstream consumers
-- (PB title formatting, future analytics) can read the specific service
-- the patient was booked for — e.g. "Labs - Access Custom" — rather than
-- only the mapped lab destination ("Access").
--
-- Before this migration the service name was stashed in lab_cases.notes
-- by the worker/cases sync handler. Keeping it in a dedicated column
-- avoids regex-parsing notes for the rich title format on PB uploads.

alter table lab_cases
  add column if not exists zenoti_service_name text;

create index if not exists lab_cases_zenoti_service_name_idx
  on lab_cases (zenoti_service_name)
  where zenoti_service_name is not null;

comment on column lab_cases.zenoti_service_name is
  'Verbatim Zenoti service name (e.g. "Labs - Access Custom"). Set by '
  'the Zenoti sync. Used by the PB upload worker to build the labrequest '
  'title and by analytics queries that need service-level granularity '
  'beyond the mapped lab_name.';
