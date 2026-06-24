-- New board stage "With Patient" (Alex 2026-06-24 board re-sequence:
-- To Do · Ready to Ship · With Patient · Sample Sent · Pending Upload · Upload Complete · …).
--
-- Staff-advanced, not auto-derived: there is no Zenoti/tracking/PB signal that
-- reliably means "the kit is physically with the patient", so this is a one-tap
-- timestamp set from the card ("Given to patient"). A timestamp (not a boolean)
-- doubles as an audit trail. Independent of the numbered step1..9 pipeline — it
-- does NOT renumber anything, so the Nadia "all at step5" trigger, the X/9
-- counter, and the result pipeline are untouched.
--
-- Board placement (src/lib/columns.ts getColumnFor): a card shows in "With
-- Patient" when with_patient_at IS set AND step1_sample_sent is false (takes
-- precedence over "Ready to Ship"). Once step 1 ticks, "Sample Sent" wins, so
-- the card leaves this lane without the timestamp needing to be cleared.
--
-- Nullable, no default, no backfill: existing in-flight cases predate the stage
-- and correctly never passed through it.
alter table lab_cases
  add column if not exists with_patient_at timestamptz;

comment on column lab_cases.with_patient_at is
  'Staff-set "kit is physically with the patient" timestamp (the "Given to '
  'patient" tap). Drives the "With Patient" board lane when set and '
  'step1_sample_sent is false. Independent of the numbered step1..9 pipeline.';
