-- Phase 6.2 — Gmail OAuth token storage and sync state.
-- Run in Supabase Studio → SQL Editor.

create table if not exists gmail_oauth_tokens (
  id            text primary key default 'primary',
  email         text not null,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  scopes        text[] not null,
  last_synced_at timestamptz,
  last_history_id text,
  updated_at    timestamptz not null default now()
);

alter table gmail_oauth_tokens enable row level security;
