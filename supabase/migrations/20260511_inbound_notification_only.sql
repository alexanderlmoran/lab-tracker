-- Add `needs_manual_pull` status for notification-only lab emails (Vibrant,
-- Genova, etc. that say "log in to view your results" with no attachment).
-- These were previously surfaced as `failed`, which conflated parser bugs
-- with lab-side workflow.

alter table inbound_emails
  drop constraint if exists inbound_emails_parser_status_check;

alter table inbound_emails
  add constraint inbound_emails_parser_status_check
  check (parser_status in (
    'pending','parsed','failed','applied','dismissed','needs_manual_pull'
  ));
