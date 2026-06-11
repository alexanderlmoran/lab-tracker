-- IV Charting: one row per Zenoti "IV -" appointment plus the charting state
-- needed to generate a PracticeBetter session note.
--
-- Why this exists: PB session notes for IV infusions were created by hand and
-- frequently went missing or used the wrong template (Custom / PC / add-ons).
-- This table is the source of truth for the IV Charting tab — it mirrors the
-- day's Zenoti IV appointments (synced via fetchZenotiIvAppointments) and holds
-- the vitals + components + posting status for each.
--
-- Classification (kind / is_add_on / weber / template_hint) comes from
-- classifyIvService (worker/src/zenoti/iv-mapping.ts). The editable charting
-- form (vitals, IV start, components table, reactions) lives in `chart` jsonb so
-- its shape can track the PB template without a migration each time; only the
-- columns we filter/sort/join on are promoted to real columns.

create table if not exists iv_sessions (
  id                     uuid primary key default gen_random_uuid(),

  -- ── Zenoti source (idempotency key = appointment id, like lab_cases) ──
  zenoti_appointment_id  text not null unique,
  zenoti_guest_id        text,
  patient_first_name     text,
  patient_last_name      text,
  patient_full_name      text,
  patient_email          text,
  patient_phone          text,
  service_name           text not null,
  service_id             text,
  therapist_name         text,
  zenoti_note            text,
  session_date           date not null,
  start_at               timestamptz,
  cancelled              boolean not null default false,

  -- ── Classification (classifyIvService) ────────────────────────────────
  kind                   text not null default 'standard',  -- standard|addon|pc|custom|ebo
  is_add_on              boolean not null default false,
  weber                  boolean not null default false,
  template_hint          text,

  -- ── PC infusion (entered in the tab or sourced from Zenoti consumables) ─
  pc_infusion_number     integer,
  pc_vial_count          text,

  -- ── Charting form (vitals, IV start, components, reactions, removal) ───
  -- Free-form so it tracks the PB template; the IV Charting tab owns its shape.
  -- Standard components are pre-filled from the PB template at post time; this
  -- holds the staff-entered overlay (vitals, add-ons, lot #, expiration).
  chart                  jsonb not null default '{}'::jsonb,

  -- ── PracticeBetter posting ────────────────────────────────────────────
  pb_client_record_id    text,        -- resolved PB patient record id
  pb_note_id             text,        -- set once the session note is created
  -- pending: synced, not charted · ready: charted, awaiting Approve ·
  -- posted: note created in PB · skipped: handled manually / not charted
  charting_status        text not null default 'pending',
  posted_at              timestamptz,
  last_error             text,

  updated_at             timestamptz not null default now(),
  updated_by             text,
  created_at             timestamptz not null default now()
);

create index if not exists iv_sessions_date_idx
  on iv_sessions (session_date);

create index if not exists iv_sessions_status_idx
  on iv_sessions (charting_status)
  where charting_status in ('pending', 'ready');

drop trigger if exists set_iv_sessions_updated_at on iv_sessions;
create trigger set_iv_sessions_updated_at
  before update on iv_sessions
  for each row execute function set_updated_at();

alter table iv_sessions enable row level security;
