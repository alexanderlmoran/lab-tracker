-- Phase 8: live carrier tracking columns on lab_cases.
-- Run in Supabase Studio → SQL Editor.

alter table lab_cases
  -- Carrier code: 'fedex' | 'ups' | 'usps' | null. v1 only populates fedex;
  -- ups/usps reserved for future adapters.
  add column if not exists tracking_carrier text,
  -- Normalized status: 'pre_transit' | 'in_transit' | 'out_for_delivery' |
  -- 'delivered' | 'exception' | 'returned' | 'unknown'. Carrier-specific
  -- codes get mapped to this set in the adapter.
  add column if not exists tracking_status text,
  -- Carrier's verbatim description for display ("Picked up", "On FedEx
  -- vehicle for delivery", etc.). Useful when the normalized status loses
  -- nuance.
  add column if not exists tracking_status_detail text,
  -- When the carrier last reported the most-recent event.
  add column if not exists tracking_event_at timestamptz,
  -- When we last polled the carrier API. Cron uses this to skip cases that
  -- were polled within the last hour.
  add column if not exists tracking_polled_at timestamptz,
  -- Stable timestamp of the delivery event itself (carrier-reported), so
  -- "delivered N days ago" doesn't drift if we re-poll a delivered package.
  add column if not exists tracking_delivered_at timestamptz,
  -- Last reported location ("Memphis, TN", "Miami, FL"). Free-text from carrier.
  add column if not exists tracking_location text;

create index if not exists lab_cases_tracking_polled_idx
  on lab_cases (tracking_polled_at)
  where tracking_polled_at is not null;

create index if not exists lab_cases_tracking_status_idx
  on lab_cases (tracking_status)
  where tracking_status is not null and tracking_status <> 'delivered';

alter type lab_event_kind add value if not exists 'tracking_refreshed';
