-- Capture the patient's sample-collection date on case creation. Distinct
-- from step1_sample_sent (which is "we shipped it to the lab") and from
-- created_at (when the row was inserted). The collection date anchors the
-- expected-result-date prediction more accurately than "today" does for
-- back-dated cases entered after the fact.

alter table lab_cases
  add column if not exists collection_date date;
