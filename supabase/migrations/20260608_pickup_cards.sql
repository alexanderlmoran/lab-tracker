-- Extend the existing pickup tracking so a scheduled carrier pickup's
-- confirmation is also stamped on cards by the live "Schedule pickup" flow,
-- with the date and carrier. `pickup_confirmation` already exists (added by
-- 20260512_pickup_confirmation.sql, populated from the Lab Shipping CSV import);
-- we reuse it and add the date + carrier so the data is carrier-aware (UPS slots
-- in later for Cyrex).

alter table lab_cases
  add column if not exists pickup_scheduled_date date,
  add column if not exists pickup_carrier text;  -- 'fedex' | 'ups'
