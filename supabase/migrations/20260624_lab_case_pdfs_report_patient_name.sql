-- Persist the REPORT's own patient identity on each staged PDF.
--
-- Incident this guards against: a result PDF for one patient was attached to
-- another patient's case and a human approved it onto the wrong PB chart from
-- the Pending-Upload screen, never re-checking the name printed on the PDF.
--
-- Storing the report's patient name (the portal-row name the scraper matched,
-- or a best-effort PDF-text extraction) lets every downstream surface compare
-- it against the case's patient_name:
--   1. result-ready stamps it at attach time (worker/src/tracker-client.ts →
--      portalPatientName, falling back to a cheap PDF-text grab).
--   2. The Approve / Pending-Upload review modal shows it side-by-side with
--      the case patient and RED-banners + disables Approve on a last-name
--      mismatch (src/lib/labs/patient-name.ts → lastNameKey).
--   3. The pb-upload claim guard (api/worker/pb-upload/next) REFUSES to hand a
--      job to the PB uploader when the last names differ — defense in depth.
--
-- Nullable: older rows + reports with no exposed name stay null and fall back
-- to the portal/UI name; null never blocks (the result-ready accession tie is
-- the fail-closed backstop).
alter table lab_case_pdfs
  add column if not exists report_patient_name text;

comment on column lab_case_pdfs.report_patient_name is
  'The patient name as printed on the report itself (portal-row name the '
  'scraper matched, else a best-effort PDF-text extraction). Compared against '
  'lab_cases.patient_name (last-name key) to block a wrong-patient upload at '
  'the Approve screen and the PB-upload claim guard. Null = unknown → falls '
  'back to the portal/UI name and the accession tie.';
