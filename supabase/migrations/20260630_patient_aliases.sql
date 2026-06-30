-- Patient merge (dedup). There's no canonical patient table — patients are
-- keyed by lab_cases.patient_email — so merging two records means re-keying the
-- alias email's cases onto the canonical email. This table records each merge
-- for audit + reversibility (the cases lose the old email otherwise).
--
-- alias_email  = the email merged AWAY (e.g. leila@centenrwellness.com, a typo)
-- canonical_email = the surviving patient email (leila@centner.com)

create table if not exists patient_aliases (
  alias_email     text primary key,
  canonical_email text not null,
  display_name    text,
  merged_by       text,
  merged_at       timestamptz not null default now()
);

create index if not exists patient_aliases_canonical_idx
  on patient_aliases (canonical_email);

alter table patient_aliases enable row level security;
