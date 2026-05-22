# Automation Strategy — Lab Tracker

**Decision date:** 2026-05-21 (original) — **revised 2026-05-21 evening** after PB + Zenoti integrations shipped end-to-end.
**Status:** active

## The model: middleware, not lights-out

Lab tracker is the human-gated middleware between Zenoti, lab portals, and PracticeBetter. Automation handles the boring 95% (case creation, transit tracking, scraping, downloading, matching, uploading). A human approves the one step where a wrong answer is catastrophic: **"this PDF goes on this chart."**

## What automates vs what stays human

**Automated** (no human input):
- Zenoti appointment → tracker case creation in "New" column (Zenoti sync cron)
- FedEx transit status → step auto-advance on delivery (FedEx cron, shipped)
- Lab portal polling → PDF download + attach to case (per-portal scraper cron)
- After human Approve click → PB upload + step 5 auto-advance (PB uploader worker)

**Human** (only two touch points):
1. **On a New card:** enter tracking number + accession #, click step 1 to confirm sample sent.
2. **On a Pending Upload card:** open modal, review PDF, click Approve (or Wrong PDF / Retry).

## Why not full autopilot

- **Wrong-patient PDF upload = HIPAA breach + clinical safety incident.** Confident wrong answers from a robot are worse than a slower human. The approval click contains this blast radius.
- **Lab portals change without notice.** A queue model surfaces failures immediately ("no Access results today, something's wrong"). Lights-out automation rots silently.
- **Accession # entry remains manual on purpose.** The accession is the gold-standard match key. Once a human enters it, subsequent scrapes are deterministic. Without it, we fall back to name+DOB matching which is correct ~95% of the time — the approval click catches the 5%.

## End-to-end flow

```
[1] Zenoti appointment created (e.g. "Labs - Access Custom" for Leila Centner)
       ↓ AUTOMATED — Zenoti sync (read path shipped, cron pending)
[2] Tracker case created in "New" column
       • patient name / email / phone           (from Zenoti)
       • lab_name (e.g. "Access")                 (from service mapping)
       • collection_date                          (from appt starttime)
       • zenoti_appointment_id                    (idempotency key)
       ↓ HUMAN — staff enters tracking # + accession #, clicks step 1
[3] Sample Sent column
       ↓ AUTOMATED — FedEx tracking cron (shipped)
[4] On delivery: step auto-advances (Partial Received or Complete Received)
       ↓ AUTOMATED — Lab portal scraper (Access shipped, others TBD)
[5] Result PDF downloaded → attached to case → moves to "Pending Upload"
       ↓ HUMAN — staff opens modal, reviews PDF, clicks Approve
[6] AUTOMATED — PB uploader (HTTP, ~2s)
       • patient match in PB by name + DOB
       • upload PDF as labrequest
       • step 5 auto-advances → "Complete Uploaded"
[7] Downstream emails / ROF scheduling continue as today
```

**Time saved per result:** ~5 min manual workflow → ~10 sec of human time (tracking/accession entry + Approve click).

## Status of each phase

| Phase | Scope | Status |
|---|---|---|
| 0 | Access portal walkthrough — capture selectors and flow | ✅ shipped 2026-05-21 |
| 1 | Access scraper — login, inbox parse, PDF download, case match | ✅ shipped 2026-05-21 (verified end-to-end against Leila's 3 results) |
| 2 | PB uploader — HTTP-only via undici | ✅ shipped 2026-05-21 (verified — 1.8s upload to Leila's chart) |
| 3 | Zenoti reader — appointment fetch + filter | ✅ shipped 2026-05-21 (dry-run verified for today + future date) |
| 4 | Lab card UI — accession field + Pending Upload column + PDF modal | ✅ shipped 2026-05-21 |
| 5 | Schema — `lab_external_ref`, `lab_case_pdfs`, `lab_case_audit`, Zenoti link cols | ✅ shipped 2026-05-21 (migrations applied) |
| 6 | Wire Zenoti → tracker case creation (sync handler + cron) | ⏳ next session |
| 7 | Wire Approve → PB upload job worker | ⏳ next session |
| 8 | Patient DOB enrichment via Zenoti `/api/Guests/<id>` | ⏳ next session |
| 9 | Capture remaining lab portals (Vibrant, Cyrex, Spectracell, Genova, GlycanAge, DoctorsData) | ⏳ next session |
| 10 | Settings UI — portal capture/recapture management | ⏳ later |
| 11 | 400+ historical labs backfill audit (the killer feature) | ⏳ after Phase 7 |

## Architectural commitments

1. **PB writes are never unattended.** Always triggered by a human Approve click, always with confirmed patient. Even though the API works, we keep the modal gate.
2. **Worker is stateless.** All persistence lives in the tracker. Worker is a thin job runner.
3. **Match scoring is visible.** Every queue row shows confidence: `lab_external_ref` exact = 100%, name+DOB exact = 95%, fuzzy name + DOB = 80%, below 80% = "needs manual match."
4. **Per-scraper / per-uploader kill switch** in the planned settings UI. Disable a broken integration without redeploying.
5. **Smoke-test cron per integration.** Logs in once an hour; alerts on auth failure or schema drift.
6. **Audit log every automated action.** Append-only via RLS. `lab_case_audit` table.
7. **Transport-agnostic adapters.** Zenoti is split into types / mapping / fetch so we can swap from cookie-session (today) to official API (when it arrives) without touching the sync handler. Same pattern for any future portal that releases an API.

## Constraints (do not violate)

- Hosting: Vercel for tracker, Fly.io for worker. **No Mac mini / on-prem.**
- Cost: target <$50/mo marginal infra cost.
- Lab portal scraping: behave like a slow human. Rate-limit hard. Use dedicated automation logins, not clinician accounts.
- PB and Zenoti: same — automation-account or shared service credentials, not Alex's personal login long-term.

## Open risks (mitigations are in the doc, not solved)

- **Fly.io IP blocks** on lab portals — only address if observed.
- **TOS violations** on PB / lab portals — not enforced at our scale historically, but real. Stay low-volume.
- **Cookie expiry** for cookie-session adapters (Zenoti today, until official API). Expect ~24h freshness. Re-capture or implement OAuth password-grant replay headlessly. Will be moot for Zenoti once the API lands.
- **Edge cases eat time** — amended results, multi-PDF reports, results without a matching open case. Queue model contains the blast radius (human handles weird ones).

## Lab-specific notes

**Access Medical Labs:** scraper targets `access.labsvc.net/labgen/`, NOT `accessmedlab.com`. PDFs are served inline through Chrome's PDF viewer extension which intercepts `response.body()` — solution is `context.route()` network-layer interception. See `worker/src/scrapers/access.ts` and memory `project_lab_tracker_access_portal`.

**PracticeBetter:** the public API has no upload endpoint, but the web app's internal API does. We use OAuth password-grant → `/api/batch?context=uploadTokens` → S3 pre-signed PUT → `/api/consultant/labrequests`. CSRF double-submit cookie required (`bcm_csrf` → `x-xsrf-token` header), plus `x-company-id`, `x-session-id`, `x-platform`, `x-timezone` headers. See `worker/src/uploaders/practicebetter.ts` and memory `project_lab_tracker_pb_uploader`.

**Zenoti:** `POST /Appointment/ApptExtV2.aspx/setDate` returns a day's appointments in a double-wrapped JSON envelope. Service-name substring match identifies lab appointments. Cookies from a captured `storage.json` work for ~24h. Official API ETA ~2026-05-28 from Zenoti — when it lands, swap `worker/src/zenoti/fetch-browser.ts` for `fetch-api.ts`. See memory `project_lab_tracker_zenoti_sync`.

## Related

- `worker/src/scrapers/access.ts` — Access scraper
- `worker/src/uploaders/practicebetter.ts` — PB uploader
- `worker/src/zenoti/` — Zenoti adapter
- `~/.claude/skills/lab-portal-capture/` — capture skill for new portals
- `docs/ACCESS_PORTAL_CAPTURE.md` — Access portal selectors + flow (older, partially superseded by the access.ts comments)
- Memory entries: `project_lab_tracker_automation_strategy`, `project_lab_tracker_access_portal`, `project_lab_tracker_pb_uploader`, `project_lab_tracker_zenoti_sync`
