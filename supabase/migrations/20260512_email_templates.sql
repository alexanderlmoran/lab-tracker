-- Editable per-kind overrides for the 4 patient email templates. Code holds
-- the defaults; any row here wins. Missing fields keep the default value —
-- e.g. you can override just the subject and keep the default body.
--
-- `paragraphs` is stored as a single text blob, paragraphs separated by a
-- blank line. Placeholders supported at render time:
--   {patientFirstName} {patientName} {labName} {labPanel} {labLabel}
--   {turnaroundText}   {practiceName} {practicePhone} {pbPortal}

create table if not exists email_templates (
  kind        text primary key,
  subject     text,
  heading     text,
  paragraphs  text,
  bcc         text,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_email_templates_updated_at on email_templates;
create trigger set_email_templates_updated_at
  before update on email_templates
  for each row execute function set_updated_at();

alter table email_templates enable row level security;
