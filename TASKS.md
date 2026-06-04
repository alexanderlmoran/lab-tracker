# Lab Tracker — Backlog

Add new entries at the top of each section. Move items to `## Done` once shipped.
See also `docs/PLAYBOOK.md` (reuse index — read before building).

## Roadmap — 2026-06-04 (current priorities, Alex's order)

Order Alex set: **(2) partials safety → (3) FedEx pickup → reconcile the 57 → invoice gating.**
The single biggest UNPROVEN thing remains: **no real PB post has ever run end-to-end** — only the synthetic Leila test patient. Prove it the next time a real *complete* result is in a portal.

### (2) Partials safety — v1 SHIPPED, hardening remains
Vibrant & Access drip partial results; the scraper grabbed a finished section and (because scrape-all never passed isPartial) marked the whole case COMPLETE → could post an incomplete lab + fire the all-done cascade.
- **DONE:** `ScrapeResult.isPartial` + `ResultReadyPayload.isPartial` threaded; `scrape-all` force-stages `PARTIAL_PRONE_LABS = {vibrant, access}` as **partial (step 2)** so they never auto-complete. Human confirms completeness at Approve.
- **TODO real completeness detection:** HAR-capture Vibrant `getReportStatusListV2` for a PARTIAL order (e.g. Michelle Scheumeister, 4/112 markers) AND a COMPLETE one → diff to find the pending/total field → set isPartial precisely instead of always-partial. Access: find its complete-signal (recipe-level `isPartial`).
- **TODO UI:** "Approve as complete vs partial" affordance in the PDF review modal (right now the human can't promote a staged partial to complete on approve).
- **TODO:** apply the partial-prone override to `/run` (server.ts), not just scrape-all.

### Turnaround auto-learn (Alex idea 2026-06-04)
Poll daily for when results actually arrive; measure the real sample→result turnaround per lab; write it back to **Settings → Lab catalog turnaround** (`labs_catalog.turnaround_days_min/max`). That turnaround drives the auto-pull result-window (`open-cases` effectiveWindow), which drives get-PDF + post. So learned turnaround = tighter, self-tuning detection. Source data: `lab_events` (sample-sent timestamp) → first result-staged timestamp.

### (3) FedEx schedule-pickup button
FedEx is already configured (tracking). Use their **Create Pickup API** (same OAuth) → a "Schedule FedEx pickup" action on the board (per-day or per-shipment) that books the pickup from the clinic address and stores the confirmation # on the case(s).

### Reconcile the 57 (sample-sent backlog)
Today's `open-cases` fallback-window fix (commit d77161a) already makes **accessioned** sample-sent cards auto-pull. Remaining: surface which sample-sent cards **lack an accession** (can't scrape) so staff add it via the grid 🔍 probe.

### Invoice gating (chief's ask — needs requirements first)
Chief wants Zenoti **invoice / paid / closed-invoice / package** status surfaced on cards to decide if labs should be sent, with a notification. BLOCKED until Alex learns Zenoti's invoice/package model from him. Then: pull paid/closed status per guest/appointment → "OK to send" badge + unpaid notification.

### Reports — work-volume metrics over time
Add an "Activity over time" section to `/labs/reports` from `lab_events`: cases created/day, advanced/day by step, patients touched ("yesterday I did 12–18"). 

### Other queued
- **Vibrant one-PDF-per-accession** (linked result group): one scrape of an accession attaches the same PDF to all cards sharing it + advances them together (no 3× work; keeps per-lab cards).
- **Genova session is DEAD** (reCAPTCHA+MFA) — refresh before any Genova case can pull.

## End-state pipeline (the vision we're building toward)

The full automated flow Alex articulated 2026-05-21. Everything below this section either supports this flow or is unrelated maintenance.

```
[1] Zenoti appointment created (e.g. "Labs - Access Custom" for Leila Centner)
       ↓ AUTOMATED — Zenoti sync (cron, every N min)
[2] Tracker auto-creates a case in the "New" column
       • patient name / email / phone / DOB         (from Zenoti)
       • lab_name (e.g. "Access")                    (from service mapping)
       • collection_date                              (from appt starttime)
       • zenoti_appointment_id                        (idempotency key)
       ↓ HUMAN — staff enters tracking # + accession #, clicks step 1
[3] Sample sent
       ↓ AUTOMATED — FedEx tracking cron (already shipped)
[4] Sample delivered to lab → step 2 / step 4 auto-advances
       ↓ AUTOMATED — Lab portal scraper cron (Access today; others TBD)
[5] Result PDF downloaded → attached to case → "Pending Upload" column
       ↓ HUMAN — staff opens modal, reviews PDF, clicks Approve
[6] AUTOMATED — PB uploader (HTTP, ~2s)
       • patient match in PB                          (by name + DOB)
       • upload PDF as labrequest
       • step 5 auto-advances → "Complete uploaded"
[7] Downstream emails / ROF scheduling continue as today
```

**Human touch points** (the only places staff intervenes):
1. Enter tracking number + accession # on a New card → click step 1 to confirm sent
2. Approve PDF in the modal (or Wrong PDF / Retry as needed)

**Everything else** — case creation, transit tracking, result polling, PDF attachment, step 4 toggle, PB upload — runs unattended.

## Status as of 2026-05-22 evening

**End-to-end pipeline is LIVE.** Two real labrequests verified on Leila Centner's PB chart. `npm run dev` starts all four processes (Next + PB worker + Zenoti loop + auto-attach watcher) in one terminal.

Single-command demo path:
1. `npm run dev`
2. Book lab appointment in Zenoti
3. Within 60s, refresh tracker → case in **New** column
4. Click card → enter Tracking + Accession # → Save → click step 1
5. Within 5s, PDF auto-attaches → step 4 auto-flips → card lands in **Pending Upload** with amber banner
6. Click Review PDF → Approve & upload
7. Within 5s, PB upload completes → card moves to **Complete Uploaded**

**Newly automated this session:**
- Step 4 auto-flips when the scraper attaches a PDF (no manual click)
- Cancelled Zenoti appointments → matching tracker case soft-deleted on next sync tick
- Kanban reorder: New → Sample Sent → **Pending Upload** → Partial Uploaded → Complete Uploaded → ROF…
- Settings → Scrapers tab lists all 11 portals with configured / not configured / never-run status + daily HTTP health badge (green / yellow / red) populated by /api/cron/portal-health
- Capture wizard: per-portal expandable wizard scaffolds `worker/src/scrapers/<key>.ts` stub from a captured Playwright session, leaving TODO markers pointing at the HAR for completion

## Smart Auto Lab Tracker — strategic vision (decided 2026-05-26)

The next phase isn't more pipeline plumbing — it's making the lab tracker *think*. Three intertwined AI-driven layers, sequenced because each depends on the previous:

### Layer 1 — Smart capture wizard (AI-generated scrapers)

Today's Phase 2 wizard scaffolds an empty stub from a captured Playwright session. Layer 1 makes it actually write the scraper:

- ✅ Settings → Scrapers row → "Analyze with AI" button (after capture exists) — shipped 2026-05-26 (commit cca0a36)
- ✅ Server reads the HAR, slims it (drops response bodies, keeps request signatures + headers + bodies + first-800-chars-of-each-response, caps at 80 entries) — shipped 2026-05-26
- ✅ Optional notes field on the wizard: free-text context staff types during/after the recording — shipped 2026-05-26
- ✅ Claude sonnet-4-6 gets the slimmed HAR + notes + canonical access.ts template; returns proposed TypeScript scraper — shipped 2026-05-26
- ✅ Diff view; "Save scraper" writes worker/src/scrapers/&lt;key&gt;.ts — shipped 2026-05-26
- ⏳ **In-app capture (no terminal)** — Settings → Scrapers row → "Record portal session" button → server triggers Playwright codegen in user's local worker → web UI shows progress → cookies + HAR captured without the user touching a bash command. Requires bidirectional comms between tracker and worker (tiny Fastify or WebSocket on the worker side). About 2-3 hours of work. Alex's stated preference 2026-05-26.
- ⏳ Drift detection: each successful scrape stamps a hash of the request shape; daily health probe compares to baseline and flags "portal X drifted, recalibrate"
- ⏳ Recapture creates v2 capture dir; wizard offers diff between v1 and v2 to update the scraper rather than start fresh

### Layer 2 — Historical backfill brain (the killer feature)

Currently ~424 lab_cases sit at step 1 (Sample Sent) with results probably already on the patient's portal and possibly already on PB. The backfill brain reconciles:

- ✅ PB endpoint discovered: `GET /api/consultant/labrequests?records=<patientId>` returns a patient's labrequests. `listPatientLabRequests()` added to worker/src/uploaders/practicebetter.ts.
- ✅ PB API quirk discovered (2026-05-26): `records=` filter is broken consultant-wide; must `listAllConsultantLabRequests({ limit: 2000 })` and filter by `clientRecord.id` locally.
- ✅ Engine v2 (`worker/src/backfill/engine.ts`): 4-bucket classifier with confidence ladder. Date window widened 45→90d (2026-05-27) for specialty labs. `panelHint` field added — fallback name match against the CSV `contents` string when `lab_name` is generic ("Custom", "Other"). Hint-only matches cap at medium confidence.
- ✅ Preview/run scripts (all preview-by-default, `--apply` to commit, `--patient=all` for full org):
  - `worker/scripts/backfill-collection-dates-from-csv.ts` — joins `Lab Shipping - Main.csv` by tracking_number, fills missing `collection_date`. Write-once: only updates rows where `collection_date IS NULL`.
  - `worker/scripts/dedupe-tracker-cases.ts` — archives true-duplicate rows (same patient + lab + tracking# + collection_date). Keeps earliest-created; Zenoti-linked row wins.
  - `worker/scripts/backfill-advance-highs.ts` — silent step5 flip on `already-on-pb + confidence=high` cases. Bypasses email triggers (Nadia / Allison / patient) via direct DB update — logs `step_toggled` event with actor=`admin:backfill-brain`.
  - `worker/scripts/backfill-leila-preview.ts` — classification report only, no mutations. Now wired to CSV contents for panelHint.
- ✅ Debug PATCH route (`src/app/api/worker/debug/cases/route.ts`) gained two new actions used by the scripts: `set-collection-date` (write-once, refuses if already set) and `advance-step5` (silent, bypasses email cascade).
- ✅ Leila end-to-end run 2026-05-27: 18 collection_dates backfilled from CSV → 7 duplicate rows archived → 5 high-confidence step5 advances applied. 23 stuck cases remain (15 medium/low on PB awaiting eyeball, 5 recent in grace window, 7 needs-review including confirmed-not-on-PB ReliGen and Viome rows).
- ✅ Engine gap closed (2026-05-31): word-token matching. The matcher now also matches on a shared content word (≥4 chars, stopword-filtered) so "Custom vaginal microbiome" surfaces PB "Microbiome Labs (BIOMEFX)" — at **low** confidence only (never auto-advances). First unit-test suite added: `worker/src/backfill/engine.test.ts` (15 cases; `cd worker && npm test`).
- ⚠️ Recipient-Name hint parked (2026-05-31): the runbook assumed CSV `Recipient Name` carries the lab destination when `Carrier="Other"`. The actual `Lab Shipping - Main.csv` contradicts this — that column holds people's names (shipper/intermediary), not labs. Feeding it as a panelHint would manufacture false matches. Don't wire in without real lab-named rows.
- ✅ Bug fixed (2026-05-31): the `set-collection-date` debug action logged a `case_backfilled` event kind that isn't in the `lab_event_kind` enum, so the audit insert failed silently (error was unchecked). Switched to the valid `case_edited` kind; both backfill PATCH actions now `console.warn` on any audit-insert failure instead of swallowing it. Header docstring updated (endpoint is no longer "always read-only").
- ⏳ Next step Alex committed to: spot-check the 5 advanced cases in the kanban, then run `--patient=all` for the dedupe + collection_date backfill across the full ~424 stuck rows. Advance step still per-patient.
- ⏳ UI: Settings → Backfill tab with filter inputs + preview button + execute approval. Phase 2.
- ⏳ Per-lab scale-out followed by full reconciliation per Alex 2026-05-26 decision tree.

### Backfill brain — operating notes (2026-05-27)

- The "8 duplicate tracking#s in Leila" discovery uncovered a broader pattern: the bulk-import ran twice, producing exact pair-dups created ~60s apart on 2026-05-08. Likely affects every patient bulk-imported in that batch. Run `dedupe-tracker-cases.ts --patient=all` once to clear org-wide.
- Tracking numbers in `lab_cases.tracking_number` are not unique-across-time: Alex sometimes logs the kit-out shipment number (not the sample-return), and FedEx recycles. Always pair tracking# with patient + carrier + date for any cross-row reasoning. See memory `project-lab-tracker-tracking-numbers`.
- Auto-fire criterion that's working in practice: `already-on-pb` AND `confidence=high` AND PB labrequest name embeds a date (e.g. "Access 03.26.26"). Date-in-name is the strongest signal we have for an unambiguous correspondence.
- Non-true-dup case to handle separately: same tracking# but different `(lab_name, collection_date)` — usually a Zenoti-sync row alongside a bulk-import row (Leila's Access 487953992901 = Access 5/22 vs Access Custom 5/21). Needs a "Zenoti reconcile" pass; current dedupe correctly leaves these alone.

### Layer 3 — AI-powered search

Natural-language search across Zenoti / portals / PB / tracker. "Show me Leila's pending Vibrant labs" → unified answer.

- Anthropic API tool-use with structured tools per data source
- Single input box in the tracker
- Claude routes to the right tools, composes the answer

### Sequencing

1. Layer 1 first (foundation for everything else)
2. Real scrapers for the 6 missing portals via the new wizard (Vibrant, Cyrex, Spectracell, Genova, GlycanAge, DoctorsData)
3. Layer 2 (backfill brain) — feasible once portals are queryable
4. Layer 3 (search) — sits on top of Layer 1 + 2

Auto-email triggers (deferred since 2026-05-22) remain on the queue but parked until the smart-tracker work above ships.

## Up next — wire it together

### Remaining lab portals (6 left)
- **What:** Capture + scaffold scrapers for: Vibrant, Cyrex, Spectracell, Genova, GlycanAge, DoctorsData.
- **Process per portal:** Settings → Scrapers → expand portal row → run the shown bash command in terminal → click "Check for captures" → "Scaffold scraper" → open new file in editor and fill the TODO body using HAR / recorded.js as reference → restart `npm run dev`. The wizard scaffolds the stub; Claude in chat can finish the request logic if you paste the HAR snippets.
- **Estimate:** ~15 min combined per portal (5 user capture, 10 LLM/manual scraper customization).
- **First question per portal:** does the lab actually push via portal, or does it just email a PDF? Email-only labs go through the existing Gmail ingest, not a new scraper.

### Capture wizard Phase 3 — AI-driven scaffolding
- **What:** Replace the empty TODO body in the scaffolded scraper with Claude API analysis of the captured HAR. Click "Generate from HAR" → server slims HAR (drops response bodies, keeps request signatures) → Anthropic API call returns proposed scraper code → user reviews diff → Save.
- **Why deferred:** HAR slimming is delicate (60+ MB files), and prompt engineering for "write a scraper from this HAR" needs iteration. Standalone session.
- **Already in place:** @anthropic-ai/sdk in deps; SCRAPER_REGISTRY; access.ts canonical pattern; scaffold endpoint stable.

### Remote-browser capture (Browserbase or similar)
- **What:** Today's wizard requires the user to run Playwright locally. For staff who don't have the dev env, integrate a hosted browser service so "Click here to open browser" opens a remote session right in the page.
- **Why deferred:** Paid service (~$50/mo for Browserbase). Not needed until non-engineers operate the system.

### Patient DOB enrichment
- **What:** After Zenoti sync creates a case, optionally call `GET apiamrs14.zenoti.com/api/Guests/<id>?Type=0` to fill `patient_dob`. The scraper's name+DOB fallback matching depends on this.
- **Caveat:** Leila's record came back almost entirely null in our capture. Many Zenoti records may be sparse. Track which records have DOB vs not, and consider a Zenoti-side data-quality pass as a separate effort.

### 400+ historical labs backfill audit (the killer feature)
- **What:** For every closed case in the tracker, check via PB API whether the matching PDF is actually on the patient's chart. Report gaps. Optionally auto-upload missing ones.
- **Approach:** Loop `select * from lab_cases where step5_complete_uploaded = true and archived_at is not null`, for each case call `GET /api/consultant/labrequests?clientRecordId=<id>` (need to verify this filter is supported — falls under Zenoti memory's "follow-up capture if needed"), diff, report.
- **Why now-possible:** The PB uploader works. The same function that uploads NEW labs can verify OLD ones.

### Patient DOB enrichment
- **What:** After Zenoti sync creates a case, optionally call `GET apiamrs14.zenoti.com/api/Guests/<id>?Type=0` to fill `patient_dob`. The scraper's name+DOB fallback matching depends on this.
- **Caveat:** Leila's record came back almost entirely null in our capture. Many Zenoti records may be sparse. Track which records have DOB vs not, and consider a Zenoti-side data-quality pass as a separate effort.

### 400+ historical labs backfill audit (the killer feature)
- **What:** For every closed case in the tracker, check via PB API whether the matching PDF is actually on the patient's chart. Report gaps. Optionally auto-upload missing ones.
- **Approach:** Loop `select * from lab_cases where step5_complete_uploaded = true and archived_at is not null`, for each case call `GET /api/consultant/labrequests?clientRecordId=<id>` (need to verify this filter is supported — falls under Zenoti memory's "follow-up capture if needed"), diff, report.
- **Why now-possible:** The PB uploader works. The same function that uploads NEW labs can verify OLD ones.

### Carry-over from prior backlog
- **UPS / USPS tracking adapters** — original entry below.
- **Live tracking status for non-FedEx carriers** — original entry below.

## Older "Up next" (carry-over from prior backlog)

### UPS / USPS tracking adapters
- **Why:** Some Lab Shipping rows ship via UPS Next Day Air or USPS. v1 of
  tracking is FedEx-only; non-FedEx tracking numbers still display the raw
  number with no status.
- **Approach options:**
  1. Port the FedEx adapter shape — three separate OAuth flows + parsers.
     Cheapest at runtime but most code.
  2. EasyPost or Shippo aggregator — one API, all carriers, ~$0.01–0.05
     per track. Less code, recurring cost.
- **Decide based on volume:** if <500 tracks/month, EasyPost is cheaper than
  the engineer-hours of three adapters. If higher, direct APIs amortize.

### Live tracking status (FedEx / UPS / USPS)
- Note: FedEx side is shipped (see Done). This entry is the UPS/USPS extension.
- **Approach options:**
  1. **Aggregator (recommended):** EasyPost or Shippo. Single API key,
     all carriers, ~$0.01–0.05 per track.
  2. **Direct carrier APIs:** UPS Tracking API + USPS Web Tools.
  3. **Email-driven:** Carriers email status updates to `labs@centnerhb.com`.
     Hook into the existing Gmail-cron pipeline; parse out tracking events.
     Cheapest, but flakier (carrier email formats change).

## Done

### 2026-05-22 (full-day automation session) — pipeline live, settings UI shipped

- **End-to-end pipeline VERIFIED LIVE.** Two real PB labrequests uploaded for Leila Centner via the click-to-PB flow (pb_labrequest `6a10870b3c74df94d6d51302` and `6a108b63f6668f4a3b8d57ce` with title `Access — Acc# 007143558`). Click-to-PB latency ~5 seconds end-to-end.
- **One-command demo.** `npm run dev` now uses concurrently to spawn Next + PB worker + Zenoti loop + auto-attach watcher with prefixed coloured logs. Single Ctrl+C kills everything. `dev:next-only` preserved as solo dev-server escape hatch.
- **Zenoti → tracker sync.** `POST /api/worker/cases` (idempotent UPSERT by `zenoti_appointment_id`, plus `cancelledAppointmentIds[]` for soft-deletion of cancelled appts). `worker/scripts/zenoti-sync-loop.ts` polls every 60s as a single Node process. All 49 Centner Zenoti services routed via canonical mapping + fallback.
- **PB upload queue + drain worker.** Migration `20260522_pb_upload_jobs.sql` (queue with `(case_id, pdf_id)` uniqueness). `approvePdf()` upserts a queued job; `worker/scripts/pb-upload-worker.ts` claims atomically via `/api/worker/pb-upload/next`, runs PB uploader, reports outcome via `/api/worker/pb-upload/result`. Default poll 5s for snappy local; override via `PB_WORKER_INTERVAL_MS` for prod.
- **PDF review modal — side-by-side reference.** Left sidebar shows "Tracker says" (Patient, DOB, Lab, Accession, Collection date) next to the embedded PDF iframe so staff can verify before approving. Amber banner in `CaseDetail` linked to the modal; gated on `pendingPdf` so it never flashes on cards without a pending review.
- **Activity log merges audit rows.** `listLabEvents` now joins `lab_case_audit` (approve / wrong-pdf / upload-failed / retry / accession-edited) into the same chronological stream as `lab_events`. New synthetic kinds `audit_*` route through `ActivityLog`'s describe() switch.
- **Auto-flip step 4 on PDF arrival.** `/api/worker/result-ready` flips `step4_complete_received=true` (or `step2_partial_received=true` if isPartial) when the scraper attaches a PDF. Writes a `step_toggled` event tagged with the scraper actor. No more manual "Complete received" click.
- **Auto-archive cancelled Zenoti appts.** `LabAppointment.cancelled` flag populated from `cancelOrNoShowStatus`; sync sends `cancelledAppointmentIds[]`; route soft-deletes the matching case and writes a `case_deleted` event.
- **Kanban reorder + rename.** New order: New → Sample Sent → **Pending Upload** → Partial Uploaded → Complete Uploaded → ROF…. Column lifecycle is now pure step-state: a card visits Pending Upload twice for labs that ship partial + complete results. Aligned with column-jump's existing step3/step5 mapping.
- **Settings → Scrapers tab.** `/labs/settings?tab=scrapers` lists all 11 known portals (registry at `src/lib/scrapers/registry.ts`). Per-portal status (Configured / Not configured / Never run / lifetime attach count + last scrape time) and HTTP health badge (Reachable / Flaky / Down) from the new daily cron. Expandable rows show pre-built capture bash command with copy-to-clipboard.
- **Daily portal health cron.** `/api/cron/portal-health` (Vercel cron `0 5 * * *` UTC) probes each portal's login URL in parallel and writes to `lab_scraper_status`. Consecutive-failure counter drives the red/yellow badges in the Scrapers panel.
- **Capture wizard (Phase 2).** Per-portal expandable wizard scans `worker/captures/<key>/` for recent captures and offers a "Scaffold scraper" button that writes a stub `worker/src/scrapers/<key>.ts` with TODO markers pointing at the HAR. AI-driven HAR analysis (Phase 3) deferred.
- **Security hardening.** `.gitignore` extended for `/Centner Labs/` (PHI PDFs), `/worker/captures/` (auth cookies + HAR with tokens), `Chrome_Passwords.csv`. `.env.local` PB credentials persisted with auto-loader at `worker/src/lib/load-env.ts`.

### 2026-05-21 (evening session) — major automation push

- **`lab-portal-capture` skill** — `~/.claude/skills/lab-portal-capture/`. Wraps Playwright codegen with HAR + storage capture; outputs to `worker/captures/<portal>/<timestamp>/`. SKILL.md documents the Chrome PDF viewer trap and the analyze workflow.
- **Access scraper** — shipped end-to-end. `worker/src/scrapers/access.ts` + `worker/scripts/test-access-leila.ts` download 3 Leila Centner PDFs correctly (verified: valid PDFs, internal accession matches filename). Uses `ctx.route()` network interception to bypass Chrome's built-in PDF viewer extension. Capture artifacts kept at `worker/captures/access-20260521-184919/`.
- **PB uploader** — shipped end-to-end. `worker/src/uploaders/practicebetter.ts` + `worker/scripts/test-pb-upload-leila.ts`. **Pure HTTP via undici, no Playwright at runtime.** 4-step flow: OAuth login → patient search → upload token (S3 pre-signed PUT) → labrequest create. Verified uploaded one of Leila's Access PDFs to her PB chart in ~1.8s. CSRF double-submit + custom headers required (see memory `project-lab-tracker-pb-uploader`). Capture at `worker/captures/practicebetter/20260521-200218/`.
- **Zenoti reader** — shipped (read path). `worker/src/zenoti/{types,lab-mapping,fetch-browser}.ts` + `worker/scripts/test-zenoti-fetch.ts`. Uses cookies from a captured `storage.json` to call Zenoti's `setDate` endpoint. Filters by service-name to "lab" appointments only. Dry-run verified for both today and June 1 with correct patient + service + time. Capture at `worker/captures/zenoti/20260521-202910/`.
- **Schema: PDF + audit + Zenoti** — migrations `20260521_lab_pdfs_and_audit.sql` and `20260521_zenoti_link.sql` applied. New columns: `lab_cases.lab_external_ref`, `zenoti_appointment_id`, `zenoti_guest_id`. New tables: `lab_case_pdfs`, `lab_case_audit` (append-only via RLS — INSERT + SELECT policies only). New enum: `lab_case_audit_action`.
- **Lab card UI: accession field + Pending Upload column** — `lab_external_ref` exposed in `CaseCard.tsx` (read-only display: "· ACC# <ref>") and `CaseFormFields.tsx` (editable input). Added `pending_upload` to `ColumnKey` + label + order; `getColumnFor()` accepts optional `CaseAttachmentState` and routes cases with a non-superseded PDF + no approve audit into Pending Upload between Complete Results and ROF Scheduled.
- **PDF review modal + 3-button approval** — `src/app/labs/PdfReviewModal.tsx` (fullscreen iframe-embedded PDF with optional notes textarea) + `src/app/labs/pdf-actions.ts` (`getPendingPdfForCase`, `approvePdf`, `disapproveWrongPdf`, `retryPdfUpload`). Buttons: Approve & Upload / Wrong PDF / Retry (visible after upload failure). All actions write to `lab_case_audit`. Disapprove also supersedes the PDF row + blanks `lab_external_ref` for rematch.

### Earlier work (in order of newest first)

- **Barcode lookup for tracking numbers** — shipped 2026-05-11. Ported the
  ZXing-based scanner from stocksafe. Camera scan + manual fallback;
  detected codes auto-fill the Tracking field in the case form. Uses
  `@zxing/browser` with native BarcodeDetector fallback for still frames.
  Files: `src/app/labs/BarcodeScanner.tsx`, `src/app/labs/CaseFormFields.tsx`.
- **Notification-only email classifier** — shipped 2026-05-11. Added
  `needs_manual_pull` status, secondary Gmail query for no-attachment lab
  result notifications, lab inference from sender domain, and per-lab portal
  URL lookup surfaced as an "Open <lab> portal" button in the inbox.
  Files: `src/lib/inbound/detect-notification.ts`, `src/lib/gmail/sync.ts`,
  `src/app/labs/inbox/page.tsx`, `src/app/labs/inbox/InboundRowActions.tsx`.
  Migration: `20260511_inbound_notification_only.sql`.
- **FedEx tracking — Vercel cron** — shipped. `app/api/cron/refresh-tracking/route.ts`
  wraps `refreshTrackingForActiveCasesCore({ actor: "cron", limit: 1000 })`
  behind `Authorization: Bearer ${CRON_SECRET}`. Current schedule in
  `vercel.json` is `0 13 * * *` (once daily ~8–9am ET); bump to hourly if
  needed.
- **FedEx tracking — manual + per-case refresh** — shipped 2026-05-08.
  OAuth2 client_credentials adapter (`src/lib/tracking/fedex.ts`),
  per-case `refreshTrackingForCase` server action, bulk
  `refreshTrackingForActiveCases` (300/click cap, 30/batch chunking, skips
  delivered + already-polled cases). UI: tracking badge on patient-card
  lab strips (color-coded by status), per-case "Refresh tracking" in
  CaseDetail, "Refresh all tracking" in kanban toolbar. Schema:
  `tracking_carrier`, `tracking_status`, `tracking_status_detail`,
  `tracking_event_at`, `tracking_polled_at`, `tracking_delivered_at`,
  `tracking_location` on `lab_cases`. Migration:
  `20260509_tracking.sql`. Audit event kind: `tracking_refreshed`. Env:
  `FEDEX_API_KEY`, `FEDEX_API_SECRET`, `FEDEX_API_BASE`.
- **Mark-as-closed shortcut** — shipped 2026-05-08. Bulk-advances every
  step on a case to true (skipping 2/3 when partial_expected=false), no
  emails fire. Reversible via per-step toggle. Surfaced in CaseDetail
  Steps section header.
- **CSV bulk import (Lab Shipping)** — shipped 2026-05-08. `/labs/import` page:
  parse Lab Shipping CSV → filter to 2026 → split multi-patient rows → match
  patient names against PB cache (auto-fill on exact match, prompt on
  ambiguous) → match carrier against catalog → preview table with per-row
  edit → commit with shared `bulk_import_id` for rollback. Server actions:
  `enrichImportDrafts`, `commitImport`, `rollbackImport`.
- **Patient-grouped kanban + lab catalog** — shipped 2026-05-08. One card per
  patient, lab strip per case showing 9-step progress. Patient column =
  earliest-unfinished step (the bottleneck). Drag/drop removed for v1.
  60-entry `LAB_CATALOG` (provider/panel/turnaround) drives lab combobox in
  case form, CSV import normalization, and result-date prediction.
- **Patient typeahead + lab combobox** — shipped 2026-05-08. `PatientPicker`
  searches PB cache by name (debounced 250ms), autofills email/phone/DOB and
  pre-links the PB record. `LabCombobox` filters the catalog with turnaround
  badges; free-text fallback for one-offs.
- **Result-date prediction** — shipped 2026-05-08. Step 1 toggle computes
  `expected_result_at_min/max` from catalog turnaround; displayed on patient
  card lab strips. Cleared when step 1 untoggled.
- **Resend domain verification** — resolved 2026-05-08. Bought
  centnerlabs.com → DKIM/SPF/DMARC verified in Resend. Sending live as
  `Centner Wellness <alert@centnerlabs.com>` with `Reply-To: labs@centnerhb.com`
  routing replies to the existing Workspace inbox.
- **GitHub repo + Vercel deployment** — shipped 2026-05-08.
  `github.com/alexanderlmoran/lab-tracker` (private). Vercel auto-deploy on
  push to `main`. Single Next.js project; no separate backend.
- **Lab API status refresh adapter framework** — pull-based; `getAdapterFor`
  registry; surfaced via "Refresh lab status" button on case detail. Adapters
  for individual labs added as they expose APIs.
- **Phase 6 email ingest (Gmail OAuth + manual upload)** — automated Gmail
  pull from labs@centnerhb.com, PDF text extraction, Claude-based parsing,
  case matching, manual upload zone for non-Gmail flows. (Parser blocked on
  Anthropic credits.)
- **Phase 5.x feature batch** — search & lab filter, soft-delete folder,
  archive view, patient list + detail with full history, reports dashboard
  (column counts, email stats, by-lab, 14-day activity), bulk archive +
  delete, stale-case detection.

## Resolved — no longer abandoned

- **PracticeBetter integration** — previously listed as abandoned (no API for
  uploads). **Resolved 2026-05-21** by reverse-engineering the PB web app's
  internal HTTP API. The `worker/src/uploaders/practicebetter.ts` module
  performs the full upload via undici — OAuth password grant → patient
  search → upload-token (S3 pre-signed PUT) → labrequest create. No browser
  automation needed in the production path. The earlier `src/lib/practicebetter/`
  PB-API code (note-push variant) remains shelved; the new uploader is what
  the Approve button calls.
