-- Persist patient sex (M/F) like patient_dob, so entering it on a req form
-- prefills the patient's future cases. Read/written by the req-form resolve +
-- generate actions (which tolerate the column being absent until this runs).
alter table lab_cases add column if not exists patient_sex text;
