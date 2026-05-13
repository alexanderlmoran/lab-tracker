-- Per-template "in use" toggle. When `enabled = false`, the email send
-- path skips dispatch (still writes a skipped audit event so the operator
-- can see it was suppressed by policy, not a failure).
-- 2026-05-13.

alter table email_templates
  add column if not exists enabled boolean not null default true;
