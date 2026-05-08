# Lab Tracker — Backlog

Future features queued behind the current sprint (PracticeBetter integration).
Add new entries at the top of each section. Move items to `## Done` once shipped.

## Blocked on external

- **Resend DNS** — IT email sent (centnerwellness.com SPF/DKIM/DMARC). Patient
  email pipeline is code-complete and held only for domain verification.
- **Anthropic API credits** — inbox PDF parser is wired but every parse 401s
  until the key has billing.
- **PB write API for labrequests/sessionnotes** — PB exposes only GET for
  these resources, so canonical lab notes currently land in `profile.notes`
  (Basic Info → Additional Notes), not the Labs or Notes & Recordings tabs.
  Need to file a PB support ticket asking when POST endpoints will be
  available; until then, mitigate with tag-based visibility (next item).

## Up next

### Tag-based PB visibility (mitigation for canonical-location gap)
- **Why:** `profile.notes` stores the data but lives under "Additional Notes,"
  which clinicians don't habitually check. Tags surface in PB's standard
  client filters and the Labs filter sidebar.
- **What:** On every successful push, also call PB's update-tags endpoint to
  apply `Lab: <name> · partial` or `Lab: <name> · final` to the client record.
- **Schema:** `relatedTags` is on ClientRecord; tag IDs are referenced by
  string ID. Need to either pre-create the tags in PB UI and store their IDs,
  or expose a one-time "tag bootstrap" sync.

### Barcode lookup for tracking numbers
- **Why:** Manual entry of carrier tracking numbers is error-prone; staff already
  scan packages on intake.
- **Source pattern:** Reuse the barcode-scan component from
  `~/Desktop/Everything/Coding_Projects/stocksafe` (already working there).
- **Where:** Small icon-button next to the **Tracking** field in `CaseDialog`
  and on the case detail. Camera-based scan, auto-fills the field.
- **Out of scope:** Carrier auto-detection (FedEx vs UPS vs USPS) — leave
  manual for v1.

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

## Backlog

### Notification-only email classifier
- Some lab emails (Vibrant, Genova) just say "your results are ready, log in"
  with no PDF attached. Today these surface as parser failures.
- Detect by: keyword scan (`log in`, `view your results`, `secure portal`) +
  attachment count = 0. Mark inbox row as `needs_manual_pull` instead of
  `failed`.
- Add per-lab portal URL lookup so we can render an "Open <lab> portal" button.

### PB document upload (vs. profile.notes)
- Today we append canonical lab summaries to `profile.notes` (the only PB
  write surface we confirmed).
- If/when PB exposes `POST /consultant/labrequests` or
  `POST .../attachments`, switch to attaching the actual PDF as a first-class
  lab document on the client record. Profile notes become a fallback.

### PB sync as cron job
- Manual "Sync PB clients" button works; better to hit it nightly via Vercel
  cron so the cache stays fresh without intervention.

## Done

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
