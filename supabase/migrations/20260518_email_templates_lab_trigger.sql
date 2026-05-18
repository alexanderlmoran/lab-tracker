-- Per-lab override layer for email templates. Previously each kind had at
-- most one row (kind was the PK). Now a row is identified by an opaque id,
-- and (kind, trigger_lab_name) is unique — so admins can author a Peptides-
-- specific "sample_sent" email distinct from the generic one, and the render
-- path picks the lab-specific row when the case's lab_name matches.
--
-- Rows with trigger_lab_name = NULL are the legacy/global row (still one per
-- kind). The unique index treats NULL as a distinct value via coalesce so
-- (sample_sent, NULL) and (sample_sent, 'Peptides') coexist.

alter table email_templates
  add column if not exists id uuid not null default gen_random_uuid();

alter table email_templates
  add column if not exists trigger_lab_name text;

-- Swap the primary key over to id. The old PK was on `kind` alone.
alter table email_templates
  drop constraint if exists email_templates_pkey;

alter table email_templates
  add constraint email_templates_pkey primary key (id);

create unique index if not exists email_templates_kind_lab_uniq
  on email_templates (kind, coalesce(trigger_lab_name, ''));
