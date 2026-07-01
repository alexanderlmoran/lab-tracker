# DB Hardening — make patient-safety structural

**Why this doc exists:** almost every patient-safety guard in this system is
**code-only** — it lives in one server route, a client modal, and an outbound worker
check. A code guard is bypassed by the next code path that forgets it, and a
service-role insert bypasses all of them. The 2026-06-24 wrong-patient incident
(INCIDENTS #1) is blocked *only* by application logic today. This doc lists the gaps
and the exact DB constraints/triggers that would make those bugs **structurally
impossible** — plus the prod-drift checks that must pass for the *existing* guards to
even work.

**Status:** audit complete (5-agent sweep, 2026-07-01, read-only — 47 migrations,
prod not queried). The SQL below is **PROPOSED, NOT APPLIED.** Every constraint must
be **data-audited first** — existing rows may violate it (esp. the Vibrant sibling
model for accessions). Ship as `add constraint … not valid;` then `validate` after
cleanup. Get Alex's go-ahead per item.

---

## The headline

The DB enforces **idempotency** and **queue-dedup** well, and enforces **zero**
identity-binding invariants:

- ✅ `lab_cases_zenoti_appointment_id_uniq` — no duplicate cases per appt.
- ✅ `iv_sessions.zenoti_appointment_id UNIQUE`, `pb_upload_jobs (case_id,pdf_id)`,
  `iv_post_jobs (session_id)` — queue dedup.
- ✅ `lab_case_audit` is append-only (RLS grants INSERT/SELECT, no UPDATE/DELETE).
- ❌ **No canonical patient table.** Identity is denormalized onto every `lab_cases`
  row; there is no FK for patient identity anywhere.
- ❌ **Accession (`lab_external_ref`) is a non-unique index** — the same accession can
  sit on two cases with different patient names. No "same accession ⇒ same patient."
- ❌ **No CHECK constraints and no triggers** on `lab_cases` / `lab_case_pdfs` beyond
  `set_updated_at()`. A direct insert into `lab_case_pdfs` bypasses the entire
  wrong-patient gate.

---

## Safety audit — invariant → enforced where

| # | Invariant | Verdict | Where |
|---|---|---|---|
| 1 | Result PDF can't attach to an unverified-identity case | **CODE-ONLY (strong)** | `result-ready/route.ts:140-156` (409 surname mismatch), `:199-232` (fail-closed quarantine), modal `PdfReviewModal.tsx:73-92`, outbound `pb-upload/next/route.ts:129-161`. No DB backstop. |
| 2 | Accession can't collide across two patients | **UNENFORCED (gap)** | `lab_external_ref` non-unique index only. Nothing stops one accession on two different-name cases. |
| 3 | Zenoti appt can't create duplicate cases | **DB-ENFORCED ✅** | `lab_cases_zenoti_appointment_id_uniq` (partial-unique). Code does check-then-insert; the index is the backstop against the race. |
| 4 | DOB consistent between `patients_seed` and case | **CODE-ONLY (weak)** | No FK/trigger/shared key. `result-ready` copies DOB from the PDF only on name+email match. Two stores can diverge freely. |
| 5 | Auto-post to PB disabled/gated | **CODE-ONLY (env flag)** | `AUTO_POST_ENABLED === "true"`, default off, `result-ready/route.ts:474`. Lives in env — **not visible or auditable in the schema.** |
| 6 | Patient merge can't orphan/mis-route cases | **CODE-ONLY (fragile)** | Two `mergePatients` (`patients/actions.ts:32`, `labs/actions.ts:876`) blind-`UPDATE patient_email/name`. `patient_aliases` is audit-only. **A merge that rewrites the email does NOT re-run the surname guard on attached PDFs.** |

**Inconsistency to resolve (not a gap per se):** the client modal lets staff override a
mismatch by retyping the case name (`PdfReviewModal.tsx:83`), and `approvePdf`
(`pdf-actions.ts:299`) does **not** re-check names server-side — but the outbound
`pb-upload/next` guard has **no override path**, so an overridden approval silently
parks the job as `failed`. Decide: is the override dead (then remove the UI) or should
the outbound guard honor it? Today it's confusing and can strand a job.

---

## Proposed constraints (data-audit first — NOT applied)

Priority order: **#1 and #6 close the actual incident class; #2 closes the collision
hole; #5 makes the kill-switch auditable.**

```sql
-- #1  Backstop the wrong-patient gate in the DB. A PDF's report name, when present,
--     must share the case's surname key. Trigger (not CHECK — it spans two tables).
--     Mirror lastNameKey semantics from src/lib/labs/patient-name.ts.
create or replace function assert_pdf_patient_matches_case()
returns trigger language plpgsql as $$
declare case_name text; ln_case text; ln_report text;
begin
  if new.report_patient_name is null then return new; end if;  -- null never blocks (matches code)
  select patient_name into case_name from lab_cases where id = new.case_id;
  ln_case   := lower(regexp_replace(split_part(case_name, ',', 1), '.*\s', ''));
  ln_report := lower(regexp_replace(split_part(new.report_patient_name, ',', 1), '.*\s', ''));
  if ln_case <> '' and ln_report <> '' and ln_case <> ln_report then
    raise exception 'wrong-patient: report % != case % (case %)', new.report_patient_name, case_name, new.case_id;
  end if;
  return new;
end $$;
create trigger lab_case_pdfs_patient_guard
  before insert or update on lab_case_pdfs
  for each row execute function assert_pdf_patient_matches_case();

-- #2  Accession may repeat across the SAME patient (Vibrant books one order as N
--     sibling cases sharing one accession) but NOT across different surnames.
create or replace function assert_accession_single_patient()
returns trigger language plpgsql as $$
declare conflict_name text;
begin
  if new.lab_external_ref is null then return new; end if;
  select patient_name into conflict_name from lab_cases
    where lab_external_ref = new.lab_external_ref and id <> new.id and deleted_at is null
      and lower(regexp_replace(split_part(patient_name,',',1),'.*\s',''))
        <> lower(regexp_replace(split_part(new.patient_name,',',1),'.*\s',''))
    limit 1;
  if conflict_name is not null then
    raise exception 'accession % already bound to different patient %', new.lab_external_ref, conflict_name;
  end if;
  return new;
end $$;
create trigger lab_cases_accession_guard
  before insert or update of lab_external_ref, patient_name on lab_cases
  for each row execute function assert_accession_single_patient();

-- #5  Make the auto-post kill-switch auditable in-DB (env stays as fallback):
insert into app_settings (key, value) values ('auto_post_enabled', 'false')
  on conflict (key) do nothing;
--   then read app_settings first, env as fallback, so policy state is queryable + logged.

-- #6  Re-validate attached PDFs when a case's identity is rewritten (merge/rename),
--     reusing the #1 surname logic so a merge can't silently re-route a chart.
--     (fire assert_* on update of lab_cases.patient_name)
```

**Not needed:** #3 (Zenoti idempotency) is already DB-enforced. Optional: promote its
partial-unique index to a named constraint so `cases/route.ts` can use a real
`upsert(onConflict)` and drop the check-then-insert race window entirely.

---

## Prod-drift verification (do this FIRST — some guards may already be dead)

Migration files are **not** proof prod matches them — several were hand-applied via the
Supabase SQL editor (enum `ALTER TYPE … ADD VALUE` can't run in a transaction) or noted
as dashboard-applied. **A missing column silently disables its guard.** Verify each on
prod (query the live DB, e.g. via `!` a `supabase`/psql call — I'm blocked from prod):

| Verify | Why it's load-bearing | Migration |
|---|---|---|
| **`lab_case_pdfs.report_patient_name` exists** | INCIDENTS #1 wrong-patient guard reads it; if absent, null never blocks and the guard **no-ops**. | `20260624_lab_case_pdfs_report_patient_name.sql` |
| `case_adopted` in `pg_enum` | `cases/route.ts` adoption writes throw without it. | `20260624_case_adopted_enum.sql` |
| `phlebotomy_event` enum value | Phlebotomy event inserts throw without it. | `20260630_phlebotomy_event_kind.sql` |
| `iv_infusion_series` table exists | PC infusion # (INCIDENTS #12) HOLDs without it. | `20260616_iv_infusion_series.sql` |
| `lab_scraper_status` table exists | Heartbeats upsert here every cycle (INCIDENTS #24/#25). Memory says it was "never applied (FIXED)" — confirm it stuck. | `20260522_*` |
| `patient_aliases` table exists | Merge audit; memory warns "2 alias commits need migration first." | `20260630_patient_aliases.sql` |
| `with_patient_at` column exists | Board resequence / With-Patient stage. | `20260624_*` |

**The watchdog already probes some of this** (`SCHEMA_SENTINELS` in the heartbeat-watch
cron) — confirm every column/enum above is in the sentinel list, and add any that isn't.

---

## The durable-fix roadmap (turn PROCESS-only into structural)

From INCIDENTS "still-open risks," ranked by blast radius:

1. **Verify prod-drift above** (checklist) — cheapest, highest-value; a dead guard is worse than no guard because it looks alive.
2. **Constraints #1, #6, #2** — close the wrong-patient + accession-collision class in the DB.
3. **Pre-deploy `next build` CI gate** — kills the tsc-invisible build breaks (INCIDENTS #18/#19).
4. **Auto-restart in the deploy path** — wire `start-all-machines.sh` into the deploy command or a Fly `release_command` (INCIDENTS #23).
5. **`auto_post_enabled` → `app_settings`** (#5) — auditable, not a silent env flip.
6. **Silent-drop → watchdog alert** (INCIDENTS #16) — a dropped `Labs -` service should page, not just log.

---

*Audit 2026-07-01. Nothing here has been applied. Each constraint needs a data-audit +
Alex's go-ahead. Cross-links: `docs/ARCHITECTURE.md` (subsystems), `docs/INCIDENTS.md`
(the incidents these prevent).*
