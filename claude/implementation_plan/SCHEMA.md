# Schema — Postgres (via Supabase)

The canonical schema lives in `supabase/migrations/20260506_init.sql`.
This doc explains the *why*, not the *what*.

## Tables

### `lab_cases`
Patient identity + lab panel metadata + step-completion booleans.

- **Patient detail fields** (`patient_phone`, `patient_dob`, `patient_address`)
  live on the case row, not in a separate `patients` table. v1 has one row
  per case; if a patient runs multiple panels we accept the duplication.
  Pull out a `patients` table only when the duplication starts hurting.
- **`lab_panel`** is free-text alongside `lab_name` for cases where one lab
  runs distinct panels (e.g. Dutch "Complete" vs. "Adrenal"). Optional.
- **Denormalized step booleans** (`step1_sample_sent` … `step9_sales_followup`)
  on the case row are intentional. Column derivation runs on every kanban
  render — joining `lab_events` to find latest state per case per step
  would be O(cases × 9). Keeping booleans on the case row makes the kanban
  a single `select`. `lab_events` is the source of truth for *when*; these
  booleans are a denormalized "latest state" cache.

### `lab_events`
Append-only audit log. Every meaningful action writes a row.

- **`kind`** is an enum — `step_toggled`, `case_created`, `case_edited`,
  `case_archived`, `case_unarchived`, `email_sent`, `email_failed`,
  `email_skipped`. The card's activity log filters / labels by kind.
- **`actor`** captures who did it. Defaults to `'admin'` in v1 (single
  user). The column is in place so multi-user later is a zero-migration
  UI change.
- **`step` and `completed`** are nullable — only `step_toggled` populates
  them. Other event kinds use `meta` (jsonb) for shape-flexible payloads
  (e.g. `{"changes": {"patient_phone": {"from": "555-1234", "to": "555-5678"}}}`
  for `case_edited`).
- **`note`** is operator-supplied free text — surfaced inline on the
  activity log. Useful when ticking step 6 to write "booked for
  2026-05-20 2pm".

### `email_logs`
Tracks every Resend send for idempotency.

- **`unique (case_id, kind)`** is the hard idempotency guarantee. Insert
  the log row first; on unique-key collision the email already sent (or
  is in flight) — short-circuit with `{ ok: true, alreadySent: true }`.
- **Failed sends** stay as rows with `status = 'failed'` plus
  `error_message`. The retry UI deletes the failed row before re-attempting.
- **Skipped sends** (operator chose "Mark complete without sending") get
  `status = 'skipped'` so future logic doesn't try to send.

## Why no `patients` table?
- One user, low volume. Carrying a join with no payoff.
- Editing patient details in one case doesn't need to propagate to others
  in the operator's mental model — they're handling one panel at a time.
- Easy to extract later: every existing case becomes a patient row, with
  cases linked back via `patient_id`. No data loss.

## Why no `users` table?
Supabase Auth owns user identity. We have one user (the super-admin) created
via Supabase Studio. `lab_events.actor` records the email of the user who
took the action — read from the Supabase session, defaults to `'admin'` if
ever missing.

## RLS policy
Every table has RLS enabled with **no policies** = deny-all. The server-side
admin client uses `SUPABASE_SECRET_KEY`, which bypasses RLS, so app code is
unaffected. The browser-exposed publishable key cannot read or write
anything — defense-in-depth in case a route handler ever leaks a query
to the client without auth.
