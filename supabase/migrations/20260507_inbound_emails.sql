-- Phase 6: inbound lab-report ingestion (manual upload + Gmail polling).
-- Run in Supabase Studio → SQL Editor.

-- ── 1. Tables ───────────────────────────────────────────────────────

create table if not exists inbound_emails (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('gmail_poll', 'manual_upload')),
  external_id         text,                          -- gmail msg id (null for manual)
  from_address        text,
  subject             text,
  received_at         timestamptz not null default now(),
  body_text           text,
  parser_status       text not null default 'pending'
    check (parser_status in ('pending','parsed','failed','applied','dismissed')),
  parser_extracted    jsonb,
  parser_error        text,
  matched_case_id     uuid references lab_cases(id) on delete set null,
  matched_confidence  text,                           -- 'high' | 'medium' | 'low' | 'none'
  applied_action      text,                           -- e.g. 'step4_complete_received'
  reviewed_by         text,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists inbound_emails_source_external_idx
  on inbound_emails (source, external_id)
  where external_id is not null;

create index if not exists inbound_emails_status_idx
  on inbound_emails (parser_status, received_at desc);

create index if not exists inbound_emails_matched_case_idx
  on inbound_emails (matched_case_id);

create table if not exists inbound_attachments (
  id                uuid primary key default gen_random_uuid(),
  inbound_email_id  uuid not null references inbound_emails(id) on delete cascade,
  filename          text not null,
  content_type      text,
  size_bytes        integer,
  storage_path      text,                              -- supabase storage key
  extracted_text    text,
  created_at        timestamptz not null default now()
);

create index if not exists inbound_attachments_email_idx
  on inbound_attachments (inbound_email_id);

-- ── 2. Storage bucket — create manually in Supabase Studio ──────────
-- Dashboard → Storage → New bucket → name: lab-inbound, private.
-- (SQL doesn't create buckets reliably across Supabase versions.)

-- ── 3. RLS — admin-only (deny all; server uses secret key) ──────────
alter table inbound_emails enable row level security;
alter table inbound_attachments enable row level security;
