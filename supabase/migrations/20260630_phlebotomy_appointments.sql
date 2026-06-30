-- Mobile-phlebotomy scheduling (Phase 1)
--
-- Some patients can't (or won't) draw their own sample, so the clinic books a
-- mobile phlebotomist to come draw it. That work lives in the "in-between"
-- window — after the kit is delivered, before the sample ships back — and was
-- previously tracked in Nadia's head. This table is the source of truth for the
-- Phlebotomy tab: one row per scheduled draw, holding the vendor, the patient's
-- date window, the confirmed appointment, the phlebotomist's cost, and the
-- lifecycle stamps (req forwarded · patient/vendor confirmed · drawn · the
-- post-draw "smooth & complete" QA).
--
-- Which cases surface in the tab is driven by lab_cases.collection_method
-- (added at the bottom): only 'mobile_phlebotomy' cases appear. A case can have
-- more than one appointment over time (a redraw), so case_id is NOT unique — the
-- board surfaces the most-recently-created appointment per case.

create table if not exists phlebotomy_appointments (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references lab_cases(id) on delete cascade,

  -- ── Vendor / phlebotomist ──────────────────────────────────────────────
  -- vendor is a known company key; 'other' carries a free-text name in
  -- vendor_other. Plain text (not an enum) to match this repo's convention
  -- (tracking_status, iv_sessions.kind) — the allowed values live in
  -- src/lib/phlebotomy.ts, not a DB check. Nullable with NO default: a freshly
  -- added case has no vendor until "Request draw" picks one, so the board can
  -- distinguish "not chosen yet" from an actual selection.
  vendor                 text,  -- draggo | speedy_sticks | other
  vendor_other           text,
  phlebotomist_name      text,

  -- ── Lifecycle status ───────────────────────────────────────────────────
  -- needs_scheduling → requested → scheduled → drawn → completed | canceled
  status                 text not null default 'needs_scheduling',

  -- ── Scheduling (patient-first: the patient gives a window, then the vendor
  --    offers a time we confirm) ─────────────────────────────────────────
  patient_window         text,         -- free-text date range from the patient
  appt_at                timestamptz,  -- confirmed appointment datetime

  -- ── Cost (the clinic's cost to the phlebotomist for this draw; tracked per
  --    appointment so spend can be totalled by vendor/period in Phase 2) ──
  price_cents            integer,

  -- ── Lifecycle timestamps ───────────────────────────────────────────────
  req_forwarded_at       timestamptz,  -- req emailed to the vendor
  patient_confirmed_at   timestamptz,  -- patient confirmed the appt time
  vendor_confirmed_at    timestamptz,  -- vendor confirmed the appt time
  drawn_at               timestamptz,  -- sample drawn
  completed_confirmed_at timestamptz,  -- post-draw "smooth & complete" QA done
  canceled_at            timestamptz,

  notes                  text,

  updated_at             timestamptz not null default now(),
  updated_by             text,
  created_at             timestamptz not null default now()
);

create index if not exists phlebotomy_appointments_case_idx
  on phlebotomy_appointments (case_id);

-- The worklist only cares about open appointments (everything not yet drawn-and-
-- shipped). Partial index keeps the status scan cheap as completed rows pile up.
create index if not exists phlebotomy_appointments_open_idx
  on phlebotomy_appointments (status)
  where status not in ('completed', 'canceled');

drop trigger if exists set_phlebotomy_appointments_updated_at on phlebotomy_appointments;
create trigger set_phlebotomy_appointments_updated_at
  before update on phlebotomy_appointments
  for each row execute function set_updated_at();

alter table phlebotomy_appointments enable row level security;

-- How the sample is collected. NULL / 'self' = the patient draws themselves (the
-- overwhelming default); 'mobile_phlebotomy' = a phlebotomist comes to them, which
-- is what surfaces the case in the Phlebotomy tab.
alter table lab_cases add column if not exists collection_method text;
