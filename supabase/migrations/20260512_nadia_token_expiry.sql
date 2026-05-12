-- Add an expiry to Nadia's confirm tokens so a stale link from a months-old
-- "all labs received" notification can't be used to flip the confirmed-at
-- field after the fact. 30 days is generous enough that real outreach
-- delays don't trip it.

alter table lab_cases
  add column if not exists nadia_confirm_expires_at timestamptz;

-- Backfill: any row that already has a token but no expiry inherits a
-- 30-day window starting from when the token was sent.
update lab_cases
  set nadia_confirm_expires_at = nadia_confirm_sent_at + interval '30 days'
  where nadia_confirm_token is not null
    and nadia_confirm_sent_at is not null
    and nadia_confirm_expires_at is null;
