-- Optional "confirmation #" entered alongside the tracking number when a
-- carrier offers a separate pickup confirmation code (e.g. UPS Smart Pickup,
-- FedEx Express pickup confirmation). Distinct from tracking_number because
-- some labs only give us the confirmation at drop-off and the tracking number
-- doesn't materialise until the carrier scans the package.

alter table lab_cases
  add column if not exists pickup_confirmation text;
