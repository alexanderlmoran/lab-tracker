# Incidents & Lessons Ledger

**Purpose:** every error, bug, gap, and near-miss since go-live (~2026-06-01), with
root cause and the **current guardrail** that prevents recurrence — or an honest
"still a risk." We do not repeat the same error twice. When a new incident happens:
add a row here, name the guardrail, and grade its enforcement.

**Enforcement grades** (weakest to strongest):
- **NONE** — nothing prevents it; latent.
- **PROCESS-only** — a human must remember / read a log / run a command. *Fragile.*
- **code** — application logic prevents it (can be bypassed by a new code path).
- **DB** — a constraint/trigger makes it structurally impossible. *Strongest.*

**The north star:** promote PROCESS-only and code-only patient-safety guards to DB or
CI enforcement. See [`DB_HARDENING.md`](DB_HARDENING.md) for the specific constraints,
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the system map each incident lives in, and
[`PLAYBOOK.md`](PLAYBOOK.md) for the reuse index. Sorted by severity: patient-safety →
data-integrity → reliability.

---

## PATIENT-SAFETY

| # | Title / Date | What happened | Root cause | Fix (SHA) | Current guardrail | Enforcement |
|---|---|---|---|---|---|---|
| 1 | **Wrong-patient result posted to PB** (2026-06-24) | Didonato's PDF (acc 007254433) attached to Etemad's case; a human approved it onto Etemad's chart, never re-checking the printed name. | Result attached with no positive patient tie; the name-check gate only ran when the scraper sent `portalPatientName`, and the Access reconcile path sent none. | `fb193c9`, `a05e28a`, `4c698cb` | result-ready **fail-closed**: no attach unless accession==case OR portal-name corroborates → else quarantine 409. Defense-in-depth surname guard at the Approve modal AND the PB uploader. `result-ready/route.ts:199-232`; `patient-name.ts` | **code** (multi-layer) |
| 2 | **Auto-post to PB disabled by policy** (2026-06-24) | Unattended auto-posting judged unacceptable after #1. | Any confidence-scored auto-post is a wrong-chart risk if matching is wrong. | `fb193c9` | `AUTO_POST_ENABLED` gate; default OFF (`result-ready/route.ts:474`). Reconcile threshold raised to 101 (unreachable). | **code** — *one env flip re-enables it* |
| 3 | **Avva → relative's chart (email fallback)** (2026-06-30) | Child's lab cross-matched a family member's PB chart via the shared parent email. | Shared family email isn't a unique key; `findPbPatient` email-fallback matched on email alone. | `aa1d8c6` | Email fallback now requires last name + first initial; no compatible hit → hold or auto-create own chart. | **code** |
| 4 | **findPbPatient guessed on missing DOB** (premortem 6/16; re-hardened via #3) | Matcher returned `candidates[0]` when the DOB matched none of several same-name charts. | Ambiguous same-name resolution defaulted to first hit. | `d7ca7de`, `a2cba98` | Matcher **refuses to guess** without DOB — holds for a human; `pdf-identity.ts` parses DOB off result PDFs (name-guarded) to fill the gap. | **code** |
| 5 | **Accession fell back to name → wrong lab** (2026-06-03) | Entered accession's report not yet on portal → matcher fell back to name+DOB and used the patient's FIRST order, attaching the wrong lab. | `matchRow` + Vibrant scraper fell back to `findPatientByName → Order[0]`. | `a06ea78`, `9871476` | Accession-exact-or-skip; name matching only when no accession. | **code** |
| 6 | **Fabricated IV vitals on charts** (2026-06-22) | `defaultIvChart` generated randomized "plausible" BP/HR/SpO2 → invented vitals landed on charts. | Placeholder-fill philosophy applied to clinical vitals. | `6a4c182` | Vitals default blank; only operator-measured values post; sweep enqueues only `charting_status='ready'`. | **code** |
| 7 | **Vibrant error-page staged as a real report** (2026-06-05) | Review modal showed a Vibrant error page as the PDF (the "JAMES FRANGI" bug); the not-ready error is itself a tiny valid PDF. | `downloadPdf` didn't validate the body; Vibrant's error is a ~879-byte valid PDF that passed a bare `%PDF-` check. | `e7070f6`, `15a01d6` | Requires `%PDF-` header AND >10KB for Vibrant; single-section-only auto-post. | **code** |
| 8 | **Drip/partial labs auto-completed** (2026-06-04) | Multi-collection labs risked completion off a partial result. | No PARTIAL stage. | `ba34cf8`, `367b8ea` | Drip labs stage PARTIAL, never auto-complete; probeByName surfaces only single-section-complete orders. | **code** |

## DATA-INTEGRITY

| # | Title / Date | What happened | Root cause | Fix (SHA) | Guardrail | Enforcement |
|---|---|---|---|---|---|---|
| 9 | **Zenoti therapist-filter dropped valid appts** (2026-07-01) | A valid appt (`Labs - Vibrant Zoomer - Toxin`, under provider "Alexander") never became a card despite valid name/date/center. | `setDate` hardcoded `strShowAllTherapist:"False"` = a therapist-filtered slice; dropped server-side with zero trace. | `8b2b1d0` | Fetch all therapists; downstream still filters to `Labs -`. `fetch-browser.ts` | **code** |
| 10 | **Silent unchecked DB writes lost data** (2026-06-16) | Unchecked `.update()` on the email step / req-form DOB silently lost data while the UI said "saved"; `markIvAlreadyDone` deleted unchecked → duplicate PB note. | Unchecked Supabase updates/deletes. | `d7ca7de`, `9464861` | Writes are result-checked and throw; delete-before-flip checked first. | **code** |
| 11 | **"Wrong PDF" blanked ALL sibling accessions** (2026-06-16) | Rejecting one PDF wiped `lab_external_ref` on every same-accession sibling. | Cascade cleared accession across the sibling group. | `b23e59b` | Scoped to the reviewed card only. | **code** |
| 12 | **PC infusion # posted un-numbered** (mid-June) | PC notes posted without a # because the drain posted before the title-parse enrich. | Number derived by racy free-text PB title parsing. | `e384348` | DB-owned counter `iv_infusion_series`, assigned pre-post; HOLD if # null. | **DB + code** |
| 13 | **Merge key collision (Genova/Vibrant + missing provider)** (2026-06-19) | Different-provider labs merged into one card. | `labGroupKey` didn't include provider. | `1b96f22` | Merge key includes provider. | **code** |
| 14 | **Vibrant date = scrape day, not collection date** (2026-06-23) | PB posts dated by scrape day; multi-section Vibrant produced multiple posts per accession. | Date off the scrape event; no per-accession merge. | `2b201bb`, `54cf8d1` | One merged post per accession, date from the report's collection date. | **code** |
| 15 | **FedEx barcode last-12 not normalized on grid scan** (2026-06-04) | Grid scan stored the whole 34-digit "96" barcode instead of the 12-digit tracking #. | Grid scan skipped `normalizeScannedTracking`. | `5e9926a` | One shared normalizer; all scan sites route through it. | **code** — *kit-out vs sample-return semantics remain a risk (open #10)* |
| 16 | **Silent lab drop on renamed/mistyped Zenoti service** (2026-06-24) | A renamed/new `Labs -` service produced NO card with zero trace. | `resolveLabName()` dropped to null silently. | `e0748de` | `console.warn` on every dropped service. | **code (visibility only)** — *someone must read `fly logs` (open #5)* |
| 17 | **Unpadded DOB mismatch across scrapers** (2026-06-15) | Divergent DOB normalization; unpadded dates could fail an identity check. | No single DOB normalizer. | `7796cbf` | One shared `normalizeDob` accepting unpadded dates. | **code** |
| 31 | **Rescheduled Zenoti appt stuck on old date (invisible)** (2026-07-01) | A Vibrant appt (Leila Centner) rescheduled 06-18 → 07-01 + service Cellular → Toxin never appeared on 07-01; the card sat on 06-18 with the old panel. Staff looked at the new day and saw nothing. | The `/api/worker/cases` existing-branch (matched by `zenoti_appointment_id`) only backfilled a MISSING service name — it never updated `collection_date`/service when an already-synced appointment moved. | `92ef9ac` | Existing-branch now mirrors the appt's `collection_date` + `zenoti_service_name` when they change (Zenoti = source of truth for its own schedule) + logs `case_edited`. Stuck cards self-heal on next sync. | **code** |

## RELIABILITY / DEPLOY

| # | Title / Date | What happened | Root cause | Fix (SHA) | Guardrail | Enforcement |
|---|---|---|---|---|---|---|
| 18 | **Prod 404s on every /api/worker/\*** (2026-06-04) | pbdrain/result-ready/open-cases all 404'd in prod (worked locally). | `.vercelignore` bare `worker` matched `src/app/api/worker/` (gitignore semantics); compounded by a sync export from a `"use server"` file. | `6be3b18`, `dee6caa` | Anchored ignore patterns; no non-async exports from `"use server"`. | **code** — *build rule tsc misses → run `next build` (open #4)* |
| 19 | **Vercel monorepo tsconfig-exclude trap** (ongoing) | Vercel build breaks if root tsconfig includes `worker/`. | Root TS project must not compile the Fly worker. | `tsconfig.json:33` | Exclusion in place. | **code** — *re-addable, doc-guarded only (open #4)* |
| 20 | **pdf.js "DOMMatrix is not defined" — prod-only** (2026-06-11) | Every Vercel PDF extraction threw; localhost passed, hiding it a day. | pdfjs's native/worker deps invisible to Vercel's file tracer; errors swallowed. | `a866278`, `fa37fc6` | `outputFileTracingIncludes` + literal import; errors surface in `parser_error`. | **code** — *verify `.nft.json` is PROCESS* |
| 21 | **PB blocks datacenter IPs (err 8000)** (2026-06-05) | Every PB call from Fly/Vercel/proxies rejected; misdiagnosed as 9999. | PB accepts only clean non-proxy IPs. | `74f609c`, `83d0f6a` | PB egress via clinic ThinkPad Tailscale exit node + retry on flap. | **code + PROCESS** — *ThinkPad must stay on; `TS_AUTHKEY` ~90d* |
| 22 | **PB 401 wedged the IV loop forever** (2026-06-11) | 5pm sweep enqueued but every post 401'd; loop reused the dead session. | Drain swallowed 401 per-job, never re-logged-in; 2 machines fought one session. | `0402c64` | Auth-error self-heal + periodic re-login; ivpost scaled to 1 machine. | **code** — *single-machine is PROCESS* |
| 23 | **`fly deploy` leaves always-on machines stopped** (ongoing) | Zenoti/IV/scrape "just stopped" after every deploy. | Fly stops always-on machines on deploy; only `app` auto-starts. | `2b1aad3` | `bash worker/scripts/start-all-machines.sh` after deploy; heartbeat watchdog backstop. | **PROCESS (fragile)** — *nothing forces the restart (open #2)* |
| 24 | **Heartbeat false-OK hid a 9-day FedEx outage** (2026-06-17) | `refresh-tracking` recorded GREEN while every FedEx poll threw. | Heartbeat recorded success unconditionally. | `b1c5356`, `5da15d5` | Failure heartbeat on errors>0/polled=0; watchdog emails on stale/failing loops. | **code** |
| 25 | **Un-applied migration drift** (2026-06-16) | `lab_scraper_status` assumed present but hand-applied; manual SQL leaves no trace. | No migration tracking for hand-applied SQL. | `b1c5356` | Watchdog probes `SCHEMA_SENTINELS` for missing tables/columns. | **code (detects) + PROCESS (apply)** |
| 26 | **Stale-claim / stuck-queue silent stalls** (2026-06-24) | A crash mid-post left jobs `claimed` forever; emails wedged `queued`. | No claim timeout / queue sweeper. | `31c67ac` | `reapStaleClaims()` + `sweepStuckEmails` + lost-kit watchdog on interval. | **code** |
| 27 | **Consumables call froze the Zenoti sync** (2026-06-15) | `GetAppointmentProducts` hangs headless, freezing the always-on loop. | Works in a browser, hangs server-to-server. | `07d1176` | Feature-flagged off (`ZENOTI_CONSUMABLES_ENABLED`) + 12s timeout. | **code** |
| 28 | **FedEx same-day pickup rejected** (2026-06-11/19) | Same-day bookings after 2:30pm rejected with a bare error. | Hardcoded ready time; no availability check. | `a866278`, `e85dce4` | Window driven by FedEx availabilities with clamps + real messages. | **code** |
| 29 | **Dark-mode `invert()` CSS trap** (burned 3×) | UI renders dark when the CSS looks light. | Dark mode = global `filter: invert(1) hue-rotate(180deg)` on root. | `globals.css:88-108` | Doc warning + `[data-no-invert]`. | **PROCESS-only** — *render-verify in Chrome (open #3)* |
| 30 | **`.kanban-col overflow:hidden` clips popovers** (2026-06-10) | Sort/category menus clipped at the column edge. | `.kanban-col` has `overflow:hidden` for rounded gradients. | `1dfbd56`, `b0e6c62` | Fixed-position popover from `getBoundingClientRect()`. | **code (pattern)** — *visual clip is PROCESS* |

---

## Still-open risks — no durable guardrail

These have **NO structural guard** — they are PROCESS-only or NONE. Ranked by blast radius.

1. **`AUTO_POST_ENABLED` is one env flip from re-enabling unattended chart posting** (#1/#2). Default-off boolean, no second-person check. → *make it an auditable `app_settings` row; require an explicit re-enable ritual.* [DB_HARDENING #5]
2. **`fly deploy` machine-stop has no automation** (#23). Restart depends on memory; watchdog fires ≤1 day later. → *wire `start-all-machines.sh` into the deploy command / a Fly release_command.*
3. **Dark-mode `invert()` trap has no lint/test** (#29). Burned us 3×. → *a lint rule flagging non-approved bg-\* utilities, or a visual snapshot.*
4. **Prod-only deploy/runtime breakage** (#18 dropped routes, #20 dead PDF stack). Vercel already runs `next build` (so a broken *build* can't ship), but the actual incidents were a deploy-config drop and a prod-only runtime failure that a local build misses. → **ADDRESSED 2026-07-01:** `npm run smoke` (`scripts/smoke.ts`) probes every critical `/api/worker|cron/*` route for not-404 (catches #18) and the watchdog now self-tests the PDF pipeline every run (`checkPdfPipeline` in `digests.ts`, catches #20 + emails). Run smoke after each deploy; wire into CI when one exists.
5. **Silent lab drops are logged, not prevented** (#16). A renamed Zenoti service or expired session produces no card; the safety is a `fly logs` line. → *turn the `console.warn` into a watchdog alert.* (Diagnostic added 2026-07-01: `worker/scripts/zenoti-debug-day.ts` dumps the raw setDate rows for a day so a missing appt is provable, not guessed.)
6. **Accession collisions across patients are unenforced.** `lab_external_ref` is a non-unique index. → [DB_HARDENING #2].
7. **The wrong-patient guard depends on `report_patient_name` existing on prod.** Hand-applied migration; if absent, null never blocks and the guard silently no-ops. → **verify now**, [DB_HARDENING §Prod-drift].
8. **SpectraCell req-form redraw checkbox suspected transposed** (`req-forms/specs.ts:68`) — a "No" X may stamp the "Yes" box; coords never verified in the calibrator. → *verify in the WYSIWYG calibrator (default disabled).*
9. **`ALLISON_EMAIL` never verified to exist** (`email/internal.ts:26`) — guessed address; step-9 notifications may reach no one. → *confirm the real inbox.*
10. **Tracking-number semantics** (#15) — a # may be the kit-*out* shipment, not sample-return, and FedEx recycles numbers. Needs name+carrier corroboration; nothing hard-blocks a mis-corroborated advance. → *corroboration gate before auto-advance.*
11. **PB egress single point of failure** (#21) — the clinic ThinkPad must stay on + `TS_AUTHKEY` renewed. Watchdog warns 14d ahead. → *hardware/PROCESS; document the renewal ritual.*
12. **Reschedule keeps STALE step-state / tracking** (#31, 2026-07-01). The date/service sync fix moves a rescheduled card to the right day, but its step booleans + tracking from the PRIOR occurrence are NOT reset — so a re-drawn appt (esp. when the test/panel changed, e.g. Leila Cellular→Toxin) lands mid-pipeline (Pending Upload) instead of "To Do". → *decide: auto-reset workflow when the derived LAB/PANEL changes (correct for a new order, but wipes prior progress), or surface a "test changed — verify" flag. Not auto-shipped — judgment call, awaiting Alex.*

---

*Built 2026-07-01 from a full git-history + code-comment + docs harvest. Add every
new incident here the day it happens — the ledger is only worth keeping if it's complete.*
