-- Shared notes per "draw" — one note for all lab cases belonging to the
-- same patient drawn on the same day. A patient with 5 labs collected
-- 2026-05-15 sees one note across all 5 cards; editing on any card
-- updates the shared note.
--
-- Keyed by (patient_key, collection_date). patient_key is the lowercased
-- email when present, falling back to lowercased patient_name. This
-- handles the realistic case of two patients with identical names by
-- preferring email when we have it.
--
-- Cases without a collection_date can't be grouped — those keep using
-- the existing lab_cases.notes column.

create table if not exists draw_notes (
  id               uuid primary key default gen_random_uuid(),
  patient_key      text not null,
  collection_date  date not null,
  body             text not null default '',
  updated_at       timestamptz not null default now(),
  updated_by       text,
  unique (patient_key, collection_date)
);

create index if not exists draw_notes_lookup_idx
  on draw_notes (patient_key, collection_date);

drop trigger if exists set_draw_notes_updated_at on draw_notes;
create trigger set_draw_notes_updated_at
  before update on draw_notes
  for each row execute function set_updated_at();

alter table draw_notes enable row level security;

-- Backfill from existing per-case notes. For each (patient_key, draw),
-- concatenate distinct non-empty notes (separated by " · ") so nothing
-- is lost. Cases without collection_date or with empty notes are skipped.
insert into draw_notes (patient_key, collection_date, body)
select
  lower(coalesce(nullif(trim(patient_email), ''), patient_name)) as patient_key,
  collection_date,
  string_agg(distinct trim(notes), ' · ') as body
from lab_cases
where collection_date is not null
  and notes is not null
  and trim(notes) <> ''
group by 1, 2
on conflict (patient_key, collection_date) do nothing;
