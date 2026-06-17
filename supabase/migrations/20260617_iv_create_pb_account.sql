-- IV charting: staff-gated "create the PB account" flag.
--
-- When the worker holds an IV post because the patient has NO PracticeBetter
-- account ("no PB candidates for query"), a held-review hold has nothing to
-- "Confirm & post" against — a dead end. Staff can now click "Create PB account
-- & post": the server action sets this flag and re-enqueues, and the post-drain
-- (when it still finds no candidate) creates the PB record via createPbPatient,
-- stamps it, and posts. Default false → nothing is ever auto-created; only a
-- staff click sets it. Cleared on a successful post (see iv-post/result route).
--
-- Run in Supabase Studio → SQL Editor.

alter table iv_sessions
  add column if not exists create_pb_account boolean not null default false;
