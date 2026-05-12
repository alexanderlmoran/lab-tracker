-- Per-lab default for whether partial results come back before the complete
-- panel. Currently only Access Blood Panel has a known partial flow; every
-- other panel defaults to "complete only" so step 2/3 stay greyed out unless
-- the operator explicitly opts in on the case.

alter table labs_catalog
  add column if not exists partial_expected boolean not null default false;

-- Seed the one known partial-flow lab. Use the canonical display name from
-- src/lib/labs/catalog.ts. Other rows stay at the column default (false).
update labs_catalog
  set partial_expected = true
  where name = 'Access Blood Panel'
    and partial_expected = false;
