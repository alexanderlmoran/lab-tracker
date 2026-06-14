# IV Charting Redesign — implementation plan

Status: PLANNED 2026-06-13. Decisions locked with Alex: **per-patient-per-day grouping
(one PB note per patient per day, all components merged, EBOO as a section)**; build all
five parts. Execute in the SAFE order below (grouping is the foundational + risky refactor).
Deploy is gated (Fly worker + Vercel) — nothing goes live until `fly deploy` + Alex tests.

## The five asks
1. **Empty-dose bug** — posted notes show blank "Standard Dose".
2. **Verify automation** end-to-end after fixes.
3. **Custom IV from Zenoti note** — parse the freeform appt note ("One IV is Curcumin 500MG…")
   into components + title, staff-confirmed.
4. **Already-charted detection** — don't hold/duplicate an IV already manually charted in PB.
5. **Grouping** — per patient per day → one note; EBOO + companion IVs (methylene blue, Myers,
   NR, trace-mineral [NEW protocol]) in that note.

## Architecture constraints (confirmed)
- `iv_sessions` = one row per Zenoti appointment; `zenoti_appointment_id` is the idempotency key.
- Post pipeline is per-session: `iv_post_jobs.session_id` (unique), `enqueueIvPost` → `/iv-post/next`
  claim → `post-drain.handle()` builds+posts ONE note → `/iv-post/result` writes `pb_note_id` back.
- `pb_note_id` lives on `iv_sessions` and drives update-vs-create. **This is the biggest conflict
  with one-note-per-day** — the note id must move to the group level.
- Note body is FORM-DRIVEN: `buildIvNoteContent`/`buildComponents` rebuild the components matrix
  from `chart.components[]`, so one note can list arbitrary components. Makes grouping feasible.
- Anthropic already wired in the app: `src/lib/inbound/parse-with-claude.ts` (haiku + cache_control
  + stripJsonFence). Reuse for #3. `ANTHROPIC_API_KEY` in root `.env.local`.

## Phase 1 — empty Standard Dose (independent, low-risk, ship first)
Root cause: (a) `sanitizeQuestion` (pb-sessionnotes.ts) blanks ALL shorttext cells incl. the
template's Standard Dose; (b) `catalogComponentsAnswer` (build-note-content.ts) refills only from
`component-doses.ts` which has 6 products.
NUANCE found 2026-06-13 by inspecting the base IV ref: the base template's "Dose" cell is EMPTY
`{}` — the dose RANGE is in the ROW LABEL ("Glutathione 200mg/mL (2.5-10ml…)"), Lot cell carries
the lot#. So "preserve the Standard Dose column" only helps templates that actually carry a cell
value. Brain Boost uses a 4-col matrix (Standard Dose | Add-On Dose | Lot# | Expiration) — VERIFY
whether its template ref carries Standard Dose values (needs a fresh studio JWT or worker path).
- If template carries doses → preserve that column in `sanitizeQuestion` (blank only Lot/Exp/Add-On).
- If not → MINE modal Standard Dose per product from historical PB notes → extend `component-doses.ts`
  (throttle; PB rate-limits). Keep catalog as fallback regardless.
- Regression guard: `iv-verify-post.ts` REF_LOTS leak assertion must still pass.

## Phase 2 — verify current automation (baseline before refactor)
IV post path (NOT /post-test): `enqueueIvPost`→`iv_post_jobs`→`/iv-post/next`→`post-drain`→PB→`/iv-post/result`;
sweep `/iv-post/sweep`; loop `scripts/iv-autopost-loop.ts`; e2e `scripts/iv-verify-post.ts`.
Run iv-verify-post DRY then COMMIT (Leila), sweep `?dryRun=1`, record which auto-post vs hold +
that re-post UPDATEs in place. This is the regression oracle for Phase 5.

## Phase 5 — per-patient-per-day grouping (FOUNDATIONAL, the crux)
**Model A (recommended): new `iv_session_groups` table; sessions reference it.**
- `iv_session_groups`: id, `group_key` unique, session_date, patient_* (denormalized), zenoti_guest_id,
  `chart jsonb` (merged day chart), `pb_client_record_id`, `pb_note_id` (NOTE IDENTITY AT GROUP LEVEL),
  charting_status, posted_at, last_error, zenoti_note, timestamps. Indexes on session_date + status.
- `iv_sessions += group_id uuid refs iv_session_groups(id) on delete set null` (keep per-session
  kind/is_add_on/weber/template_hint/service_name/start_at/zenoti_note for the merged component list).
- `iv_post_jobs += group_id` (unique), repoint from session_id; relax `iv_post_jobs_session_uniq`.
- **group_key** = `zenoti_guest_id|session_date` (fallback `lower(trim(name))|session_date`),
  normalized like match-patient.ts norm(). EBOO companions + add-ons land in the same group automatically.
- Migration + BACKFILL: create groups for existing non-cancelled sessions; copy most-complete chart;
  carry any posted member's `pb_note_id`/`pb_client_record_id`/status onto the group (so re-post UPDATEs,
  never duplicates). Backfill `iv_post_jobs.group_id`.
- Sync route (`/iv-sessions`): after per-appt upsert, compute group_key, upsert group, set group_id;
  seed default chart at GROUP level. Census reconcile: never delete a session whose GROUP has pb_note_id;
  after deleting stale members, delete groups left empty AND unposted; clear iv_post_jobs by group_id.
- Board (`iv/actions.ts listIvGroups`, `IvChartingBoard.tsx`): one row per group; multi-badge Type
  (Standard+EBOO+Custom+N add-ons); earliest start_at; group status/ids.
- Charting form (`[id]` → group id; `getIvGroup`): chart whole day; components pre-seeded from the day's
  services/templates (+ custom parse + add-ons); EBOO subsection (gauge 20 + companion components:
  methylene blue/Myers/NR/trace-mineral); PC fields if any member is pc. `saveGroupChart`/`enqueueGroupPost`.
- Post pipeline: `/iv-post/next` claim+hydrate by group (all members → kinds present); template = base
  `__base_iv__` for mixed/multi groups (components matrix is form-driven), specific protocol only when the
  whole group is one standard protocol; EBOO as extra section/labeled components. `post-drain.handle()`
  group-level: drop addon/EBOO blanket holds (merge into the note); build ONE note; `/iv-post/result`
  writes to the GROUP. `/iv-post/sweep` enqueues at group level. Held review = one entry per group.
- **Rollout:** keep EBOO-containing groups HELD for review first, then flip to auto. Keep
  iv_post_jobs.session_id nullable through cutover for rollback.

## Phase 4 — already-charted detection (per group)
Before holding/posting a group, `listSessionNotes(pb, clientRecordId)` (exists in pb-sessionnotes.ts,
GET /api/consultant/sessionnotes?records=&sort=date_desc); if a note that day has an IV-ish title
(/iv|infusion|myers|immune|chelation|ebo|phosphatidyl/i) AND our group has no pb_note_id → mark group
`skipped` ("already charted in PB"), capture detected note id for the board deep-link, do NOT create.
Run this BEFORE the auto-post gate so even a ≥95 match can't duplicate. When uncertain → HOLD ("verify"),
don't auto-skip. Optional `detected_pb_note_id` column.

## Phase 3 — custom IV from Zenoti note (per group, app-side, staff-confirmed)
New `src/lib/iv/parse-custom-note.ts` modeled on parse-with-claude.ts (haiku, cache_control, strict JSON
`{title?, components:[{name,dose}], provider?, approvedBy?}`, "extract only what's stated, don't invent doses").
Server action `parseCustomIvNote(groupId)` returns suggestion (no write). Form shows "Parse note →
components" when a member is kind=custom or has zenoti_note; pre-fills editable rows + suggested title;
staff confirm then post. Cache parse in group chart (`chart.customParse`). Keep app-side (no worker ANTHROPIC key).

## Cross-cutting
- Ship Phase 1 + verify on CURRENT model first (green baseline), THEN the refactor.
- Phase 5 cutover is the danger zone: migrate+backfill, then sweep `dryRun=1` to prove no posted day
  re-enqueues (note ids carried). Idempotency anchors: `zenoti_appointment_id` (row), `group_key` (group).
- Migrations applied via Supabase Mgmt API (ref oohgjlatfkdckopmbpcc) per PLAYBOOK.

## Critical files
worker: src/uploaders/pb-sessionnotes.ts, src/iv/post-drain.ts, src/iv/build-note-content.ts,
src/iv/component-doses.ts. app: src/app/api/worker/iv-post/{next,result,sweep}/route.ts,
src/app/api/worker/iv-sessions/route.ts, src/app/labs/iv/{actions.ts,IvChartingBoard.tsx,HeldReview.tsx,
[id]/IvChartForm.tsx}, new src/lib/iv/parse-custom-note.ts, new migration supabase/migrations/<date>_iv_session_groups.sql.
