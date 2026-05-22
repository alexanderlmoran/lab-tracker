# Lab Tracker — Backlog

Add new entries at the top of each section. Move items to `## Done` once shipped.

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

**Everything else** — case creation, transit tracking, result polling, PDF attachment, PB upload — runs unattended.

## Up next — wire it together

### Zenoti → tracker case sync (front of pipeline)
- **What:** Cron job that polls Zenoti's `setDate` endpoint daily, filters lab appointments, UPSERTs `lab_cases` rows.
- **Pieces shipped 2026-05-21:** schema (migration applied), `worker/src/zenoti/{types,lab-mapping,fetch-browser}.ts`, `worker/scripts/test-zenoti-fetch.ts` (dry-run verified).
- **Pieces remaining:**
  - Tracker API: `POST /api/worker/cases` endpoint behind `WORKER_SHARED_SECRET`. Accepts `LabAppointment[]`, UPSERTs by `zenoti_appointment_id`. New cases land in "New" column (step 0).
  - Patient detail enrichment: `GET /api/Guests/<id>?Type=0` for DOB (the setDate row has name/email/phone but not DOB). Optional second pass.
  - Cron driver: Vercel cron or Fly worker timer hitting the sync handler. Poll today + 7 days forward, hourly.
  - Storage of the captured `storage.json` cookies in a place the worker can read (env var or secrets manager). Refresh cycle when cookies expire (~24h) — until the official Zenoti API arrives next week.

### Approve PDF → PB upload (back of pipeline)
- **What:** Wire the Approve button in the modal to enqueue a job that calls `uploadPdfToPb()`.
- **Pieces shipped 2026-05-21:** `worker/src/uploaders/practicebetter.ts` (verified end-to-end), `src/app/labs/pdf-actions.ts` (approve writes audit row), `src/app/labs/PdfReviewModal.tsx`.
- **Pieces remaining:**
  - Schema: `pb_upload_jobs` table (case_id, pdf_id, status, attempts, last_error, created_at, finished_at).
  - Tracker server action `approvePdf()` already writes the audit row — extend to also insert a `pb_upload_jobs` row with status='queued'.
  - Worker poller: every 30s, claim queued jobs, run uploader, update status. On success: flip `step5_complete_uploaded = true`. On failure: status='failed' + audit row `disapprove_upload_failed`.
  - Surface failed jobs in the modal so Retry can re-enqueue.

### Settings UI: portal capture management
- **What:** A `/labs/settings/portals` page listing each lab portal + PB + Zenoti with:
  - Last successful scrape / upload timestamp
  - Cookie freshness (green / yellow / red)
  - "Recapture" button that runs the capture skill (browser opens locally for the dev — or eventually a remote Browserbase-backed flow)
  - Per-portal kill switch
- **Why:** Cookies will expire; portals will redesign their UIs; we need a non-engineer-friendly path to refresh either.
- **Approach for v1:** instructions-only page that surfaces the bash command + tracks last-known-good capture dir. Browserbase integration deferred.

### Remaining lab portals
- **What:** Capture + scaffold scrapers for: Vibrant, Cyrex, Spectracell, Genova, GlycanAge, DoctorsData.
- **Process per portal:** `bash ~/.claude/skills/lab-portal-capture/capture.sh <name> <url>` → walk through downloading one PDF → paste artifacts path → Claude scaffolds `worker/src/scrapers/<name>.ts`.
- **Estimate:** ~10 min combined per portal (5 user, 5 LLM). ~60 min for all six in one batch session.
- **First question per portal:** does the lab actually push via portal, or does it just email a PDF? Email-only labs go through the existing Gmail ingest, not a new scraper.

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
