-- Cache each IV template's component rows so the charting form can PREFILL them.
--
-- Source of truth stays the PB reference note's component matrix; this column is
-- a cache of (product label + resolved standard dose), populated by
-- worker/scripts/iv-cache-template-components.ts (same dose resolution the
-- auto-post path uses, so prefill == what posts). Re-run that script after
-- editing a template in PB.
alter table iv_template_refs
  add column if not exists components jsonb not null default '[]'::jsonb;
