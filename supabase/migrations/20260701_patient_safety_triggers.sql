-- Patient-safety structural backstops — the wrong-patient class in the DB.
--
-- Backstops INCIDENTS #1 (wrong-patient result posted) and the accession-collision
-- hole (DB_HARDENING #1/#2). Today these are guarded ONLY by application code
-- (result-ready quarantine + the Approve-modal surname check); a direct/service-role
-- insert, or a future code path that forgets the guard, bypasses them. These triggers
-- make the check structural.
--
-- ⚠️ RUN THE AUDIT QUERIES IN docs/DB_HARDENING.md FIRST. The triggers fire on
-- FUTURE writes only — existing violating rows are not retroactively blocked, but a
-- later UPDATE to one would then throw. Expected violators: 0 (Integrity reports
-- 0 collisions; the wrong-patient guard has been live since 6/24).
--
-- DESIGN — both triggers compare SURNAME KEYS via ln_key(), an exact plpgsql mirror
-- of lastNameKey() in src/lib/labs/patient-name.ts:
--   • Surname-only + "both present AND differ" == can never block anything the app's
--     own isLastNameMismatch() already allows (true defense-in-depth, no false-blocks).
--   • Respects Vibrant: one order is split into N sibling cases sharing one accession
--     for the SAME patient (same surname → never blocked). The Integrity tab's
--     full-name collision check stays as the softer detective control for the rarer
--     same-surname/different-first-name case.

-- ── ln_key: exact mirror of lastNameKey() ───────────────────────────────────
-- "PADGETT, NICOLE" / "Marc Nicole Padgett" / "nicole padgett" → "padgett".
create or replace function ln_key(s text)
returns text language sql immutable as $$
  select case
    when position(',' in cleaned) > 0
      -- "Last, First" → part before the comma, then its last token
      then regexp_replace(btrim(split_part(cleaned, ',', 1)), '^.*[[:space:]]', '')
      -- else the last whitespace-delimited token
    else regexp_replace(btrim(cleaned), '^.*[[:space:]]', '')
  end
  from (select lower(regexp_replace(coalesce(s, ''), '[^a-zA-Z, ]', ' ', 'g')) as cleaned) t;
$$;

-- ── #1  A result PDF's report name must share the case's surname ─────────────
create or replace function assert_pdf_patient_matches_case()
returns trigger language plpgsql as $$
declare v_case_name text; a text; b text;
begin
  if new.report_patient_name is null then return new; end if;  -- null never blocks (matches code)
  select patient_name into v_case_name from lab_cases where id = new.case_id;
  a := ln_key(new.report_patient_name);
  b := ln_key(v_case_name);
  if a <> '' and b <> '' and a <> b then
    raise exception
      'wrong-patient guard: report surname "%" != case surname "%" (case %, report_patient_name=%)',
      a, b, new.case_id, new.report_patient_name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists lab_case_pdfs_patient_guard on lab_case_pdfs;
create trigger lab_case_pdfs_patient_guard
  before insert or update of report_patient_name, case_id on lab_case_pdfs
  for each row execute function assert_pdf_patient_matches_case();

-- ── #2  One accession → one surname (never across different patients) ────────
create or replace function assert_accession_single_patient()
returns trigger language plpgsql as $$
declare conflict_name text; new_key text;
begin
  if btrim(coalesce(new.lab_external_ref, '')) = '' then return new; end if;
  new_key := ln_key(new.patient_name);
  if new_key = '' then return new; end if;  -- unknowable surname never blocks
  select c.patient_name into conflict_name
    from lab_cases c
    where btrim(c.lab_external_ref) = btrim(new.lab_external_ref)
      and c.id <> new.id
      and c.deleted_at is null and c.archived_at is null
      and ln_key(c.patient_name) <> ''
      and ln_key(c.patient_name) <> new_key
    limit 1;
  if conflict_name is not null then
    raise exception
      'accession % already bound to a different patient "%" (this case: "%")',
      new.lab_external_ref, conflict_name, new.patient_name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists lab_cases_accession_guard on lab_cases;
create trigger lab_cases_accession_guard
  before insert or update of lab_external_ref, patient_name on lab_cases
  for each row execute function assert_accession_single_patient();
