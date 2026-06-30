-- Dedicated activity-log kind for phlebotomy lifecycle events so they read
-- cleanly in the case ActivityLog as "Phlebotomy — <note>" (the humanizer maps
-- this kind to the "Phlebotomy" lead phrase; the note carries the specifics).
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- Apply this file STANDALONE in the Supabase SQL editor / Mgmt API (no
-- BEGIN/COMMIT), exactly like 20260624_case_adopted_enum.sql.
alter type lab_event_kind add value if not exists 'phlebotomy_event';
