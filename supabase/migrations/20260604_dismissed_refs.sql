-- Dismissed result accessions per case ("keep searching" memory).
--
-- When staff disapprove a staged PDF ("Wrong PDF — keep searching"), the old
-- behaviour blanked lab_external_ref and let the scraper re-match by name+DOB
-- next poll. For a patient whose ONLY portal result is the wrong one (e.g. a
-- case collected today but the portal only holds a 3-month-old lab), that
-- re-matches the SAME wrong result forever.
--
-- dismissed_refs caches the accession(s) staff (or the engine) have rejected
-- for this case. The scraper skips them on every future search, so the case
-- stays "searching" until a genuinely NEW result populates on the portal.

alter table lab_cases
  add column if not exists dismissed_refs text[] not null default '{}';

comment on column lab_cases.dismissed_refs is
  'Accession numbers rejected for this case (Disapprove / engine date-mismatch). '
  'The portal scraper skips these so it keeps searching for a newer result '
  'instead of re-offering the same wrong one.';
