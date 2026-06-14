-- Round out patients_seed into the full "source of truth" identity cache that
-- the Zenoti guest profile feeds (the "1 feeds the rest" enrichment). The daily
-- Zenoti appointment sync only carries name/email/phone; the guest-profile API
-- (worker/src/zenoti/fetch-browser.ts: fetchZenotiGuestProfile) adds DOB, sex,
-- and address. dob already exists; add sex + address so all five land here.
--
-- Consumers read these as fallbacks the same way they already fall back to
-- patients_seed.dob:
--   - req-form resolve (src/lib/req-forms/resolve.ts) — sex checkbox
--   - IV match scorer (src/app/api/worker/iv-post/next) — DOB (sex available too)
-- Both tolerate the columns being absent until this migration runs.
--
-- sex     : "M" / "F" (mapped from Zenoti gender_name), matching lab_cases.patient_sex.
-- address : single formatted line "street, city, ST zip" — same shape as
--           lab_cases.patient_address, so the existing parseAddress() reuses it.
-- 2026-06-14.

alter table patients_seed add column if not exists sex text;
alter table patients_seed add column if not exists address text;
