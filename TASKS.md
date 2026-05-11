# Lab Tracker — Backlog

Add new entries at the top of each section. Move items to `## Done` once shipped.

## Abandoned

- **PracticeBetter integration (all variants)** — dropped 2026-05-11. PB API
  cannot create or update session notes; profile.notes pushes land in a place
  clinicians don't look. No new PB work; existing PB code in
  `src/lib/practicebetter/` and the `practicebetter_pushes` table are on death
  row — don't extend. Tag-based PB visibility and PB document upload tasks
  removed below.

## Up next

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
- **Why:** Today we only know "tracking number entered." Not "in transit /
  delivered." Staff has to manually check carrier sites.
- **Approach options:**
  1. **Aggregator (recommended):** EasyPost or Shippo. Single API key,
     all carriers, ~$0.01–0.05 per track.
  2. **Direct carrier APIs:** FedEx Ship Manager API + UPS Tracking API +
     USPS Web Tools. Painful — three separate auth flows, three separate
     parsers.
  3. **Email-driven:** Carriers email status updates to `labs@centnerhb.com`.
     Hook into the existing Gmail-cron pipeline; parse out tracking events.
     Cheapest, but flakier (carrier email formats change).
- **Schema additions:** `lab_cases.tracking_carrier`, `tracking_status`,
  `tracking_status_at`, `tracking_events jsonb`.
- **Cron:** Reuse `lab-adapters` system shape — daily/hourly poll of active
  cases with tracking numbers.

## Done

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
- **PracticeBetter integration (canonical record push via profile.notes)** —
  shipped 2026-05-07. OAuth2 client_credentials, 1,360-client cache with
  before_id pagination, find-by-email + auto-create + manual record-link,
  audit table with idempotency, PATCH/PUT write with readback verification,
  force-rerun on manual button, auto-fire on step 5 (`complete_uploaded`).
  Health + sync diagnostics in inbox panel.
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
