-- The internal staff notice that a result landed on PracticeBetter (#21) now
-- logs to email_logs like every other send. It gets its OWN kind — logging it
-- as 'complete_uploaded' (the PATIENT email for step 5) would make the case
-- history imply the patient was emailed when only staff were.
alter type email_kind add value if not exists 'complete_upload_notice';
