# Lab Tracker — Presentation Guide

> Full feature review for presenting the system. Organized as: the problem → the
> big idea → the end-to-end flow → feature-by-feature → the hard technical wins →
> suggested talk track. Source of truth is the code; this is the narrative layer.

---

## 1. The problem (the "before")

Centner runs functional-medicine labs across **7+ outside lab companies** (Access,
Vibrant, Cyrex, SpectraCell, Genova, GlycanAge, DoctorsData) plus Kennedy Krieger.
For every patient lab, a staff member had to manually:

1. Notice a lab was ordered (in Zenoti, the scheduling/EHR system).
2. Ship the kit and track it to the lab.
3. Remember to log into each lab's portal, repeatedly, to check if results landed.
4. Download the right PDF for the right patient.
5. Upload it to the right patient's chart in **PracticeBetter** (the clinical portal).
6. Fire the right patient emails and schedule the results-review consult.

That's ~5 minutes of error-prone human work **per result**, across hundreds of
labs, spread over 7 different portals each with its own login and quirks. Wrong-patient
uploads are a HIPAA + clinical-safety incident, so it can't just be "automated and trusted."

## 2. The big idea — "human-gated middleware"

Lab Tracker is the **middleware between Zenoti, the lab portals, and PracticeBetter**.

- **Automation does the boring 95%**: case creation, shipment tracking, portal
  polling, PDF download, patient matching, and chart upload.
- **A human approves the one step where a wrong answer is catastrophic**: "this PDF
  goes on this chart." That's the single guarded click.

Result: ~5 minutes of manual work per result collapses to **~10 seconds of human time**
(enter tracking/accession, click Approve) — and increasingly to **zero** as the
confidence engine auto-posts the high-certainty cases.

**One-line pitch:** *"It watches every lab portal so staff don't have to, and only
asks a human when it's not sure."*

---

## 3. The end-to-end flow (the spine of the demo)

```
[1] Zenoti appointment "Labs - Access Custom" is booked
       ↓ AUTOMATED — Zenoti sync
[2] Tracker case created in the "New" column (patient, lab, collection date)
       ↓ HUMAN — staff enter tracking # + accession #
[3] "Sample Sent" column
       ↓ AUTOMATED — FedEx tracking cron advances the card as the kit moves/arrives
[4] On delivery: step auto-advances + predicts the result-ready date window
       ↓ AUTOMATED — per-portal scraper polls, finds the PDF, downloads it
[5] "Pending Upload" column — PDF attached to the case
       ↓ HUMAN — open modal, eyeball PDF vs. patient, click Approve
       ↓ (OR fully automated if the confidence engine scores it ≥ 95)
[6] AUTOMATED — PracticeBetter uploader posts the PDF to the chart (~2s)
[7] Step auto-advances → patient emails + results-review consult workflow continue
```

Two human touch points by design: **enter tracking/accession** and **Approve the PDF.**

---

## 4. Architecture at a glance

- **Web app** — Next.js 16 + React 19, hosted on **Vercel**. The Kanban dashboard,
  settings, PDF review, all staff-facing UI. Supabase (Postgres) for data + auth.
- **Worker** — a **Fly.io** Fastify service + a set of always-on background loops.
  Runs the scrapers (Playwright + HTTP), the PracticeBetter uploader, the tracking
  poller, the Zenoti sync, and the reconcile engine.
- **Supabase** — Postgres database, row-level-security, file storage (the lab PDFs),
  and magic-link auth.
- **Integrations** — Zenoti (scheduling/EHR), FedEx (tracking + pickup), the 7 lab
  portals, PracticeBetter (clinical charts), Resend (email), Gmail API (inbound),
  Anthropic Claude (parsing + code-gen).

Design commitments: PB writes are **never unattended without a confidence gate**; the
worker is **stateless** (all state lives in the app DB); **every automated action is
audit-logged**; integrations are **transport-agnostic** so we can swap cookie-sessions
for official APIs without rewrites.

---

## 5. Feature-by-feature

### 5.1 The Kanban dashboard (the daily driver)
The main `/labs` screen is a Kanban board with three views (tabs): **Labs**, **Patients**,
and **Tracking**.

- **9 workflow columns** on the Labs view: New → Sample Sent → Pending Upload →
  Partial Uploaded → Complete Uploaded → ROF Scheduled → ROF Done → Protocol Received → Completed.
- **Cards** show lab + panel, patient, the predicted result-ready window, tracking #,
  and a stack of smart badges: `review` (PDF waiting), tracking status, `ready?` (results
  likely up), `dup ×N` (same accession on multiple cards), contact-attempt count, and a
  staleness counter.
- **Smart filters**: search by name/email/tracking#; lab filter; time range; "Probably
  ready" (delivered + past predicted window + not yet pulled) and "Stale" (no progress 7+ days).
- **Bulk select mode** — advance a step, archive, or delete across many cards at once.
- **Merge duplicates** — multi-panel labs (e.g. Vibrant Zoomers) arrive as several cards
  sharing one accession; the board can collapse them into one merged card.

### 5.2 Case detail + the 9-step checklist
Clicking a card opens the case: an editable patient/lab record, a **9-step checklist**
(ticking a step cascades earlier ones forward; some steps fire patient emails), an
**activity log** (every event, who and when), and an **email log**. Actions include
Find Result, Refresh Tracking, Schedule Pickup, Req Form, Contact Attempt, and Archive/Delete.

### 5.3 PDF review & approve modal (the guarded click)
When a scraper attaches a result, the case lands in **Pending Upload** and clicking it
opens the review modal: a side-by-side of "what the tracker expects" (name, DOB, lab,
accession, collection date) against the rendered PDF. If the PDF's accession doesn't match
the case, a **red mismatch banner** blocks a careless approve. Buttons: **Approve**
(→ uploads to PB, advances the step), **Wrong PDF** (reject with reason), **Already
Uploaded**, **Retry**. This is the HIPAA blast-radius containment.

### 5.4 Manage Labs grid
Edit *all* of one patient's labs in a single grid — stamp tracking #, accession, and
collection date across many rows at once, add new labs without re-entering patient info,
and optionally mark them all "sample sent" on save. Patients group by **email** so
shared-email families are handled.

### 5.5 Barcode scanning
Camera-based barcode scanner (ZXing + native BarcodeDetector fallback) for tracking #
and accession entry, with rotation variants and manual fallback. Critically, every scanned
value runs through **`normalizeScannedTracking`** — a FedEx shipping label's big barcode is
a 34-digit "96" string and the actual tracking number is the **last 12 digits**; the helper
also handles 22-digit Ground SSCC and UPS 1Z. (This is a "solved once, reused everywhere" win.)

### 5.6 Requisition-form auto-fill + visual calibrator
Generates a filled-out **paper requisition form** by overlaying case data onto blank lab
PDF templates (DoctorsData, SpectraCell, Kennedy Krieger) using pdf-lib. The standout is the
**visual calibrator**: a WYSIWYG editor (pdf.js render + draggable SVG text) where staff
drag each field to the right spot, resize it, tap-to-place, and add their own custom fields —
positions persist as overrides and merge over the code defaults, so there's no
hand-tuning coordinates and redeploying. Per-form date separators space digits to clear
the MM/DD/YYYY divider boxes.

### 5.7 Tracking board (FedEx lifecycle)
A second Kanban keyed to carrier state: Needs Attention → Pre-transit → In transit →
Out for delivery → Delivered → No tracking #. Sorted so stuck shipments float up. Powered
by a FedEx tracking poller that batches calls, auto-advances "Sample Sent" when a kit starts
moving, and on delivery **predicts the result-ready window** from each lab's learned turnaround.

### 5.8 Settings (admin)
Tabbed admin: **Accounts** (invite users, assign roles), **Email templates** (4
patient-facing emails, editable + test-send + disable toggles), **Lab catalog**
(turnaround days that drive result-window prediction), **Lab portals** (sign-in URLs),
**Scrapers** (per-portal recipe view + capture/recalibrate), **Patient seed** (CSV import),
**Turnarounds** (observed collection→result analytics), and **Archived/Deleted** recovery tables.

### 5.9 Roles & auth
Supabase magic-link / email login. Three RBAC roles: **developer** (bootstrap superuser —
first user auto-promoted), **admin** (settings + accounts), **staff** (Kanban + inbox only).

---

## 6. The automation core (the technical heart)

### 6.1 The 7 portal scrapers
Each lab portal is a different beast; all 7 are verified to produce byte-identical PDFs to a
manual download. They decompose along a few axes — **transport** (browser vs pure-HTTP),
**auth**, **discovery**, **PDF fetch**, **match/ready**:

| Portal | Transport | Auth | How it finds the report | PDF fetch |
|---|---|---|---|---|
| **Access** | Browser (Playwright) | ExtJS login form | reads inbox grid; falls back to name search | **network-intercept** (Chrome PDF-viewer trap) |
| **Cyrex** | Browser | DNN form (2-field pw reveal) | per-case search in RadGrid | browser download event |
| **SpectraCell** | Browser | Orchard "Copia" form | inbox grid (slow, ~5–20s) | activate row → check → Print Selected |
| **Genova** | HTTP | **session-reuse** (reCAPTCHA+MFA → manual re-auth) | JSON + CSRF token | HTTP GET by orderNo |
| **GlycanAge** | HTTP | Firebase (tenant-scoped) | REST JSON list | HTTP stream-slice from `%PDF-` |
| **DoctorsData** | HTTP | ASP.NET form + anti-forgery token | DataTables POST | HTTP GET by ReportURL |
| **Vibrant** | HTTP | API token | findPatient by accession | PDF-engine "AllSummaryReport" |

**Key gotchas worth name-dropping:** Access's PDFs are served *inline* through Chrome's PDF
viewer which eats the response body — solved by intercepting at the network layer. Vibrant
**drips results section-by-section**, so the scraper only marks an order complete when *every*
section is finished (a single finished section ≠ done) and rejects the ~1KB "not ready" error
PDF Vibrant returns. GlycanAge/DoctorsData don't expose DOB, so those matches require the
accession to line up before auto-posting.

### 6.2 The recipe engine
Rather than 7 bespoke scrapers forever, the common patterns are abstracted into a
**config-driven recipe engine**: a recipe is *data* (pick an auth/discovery/pdf strategy +
its config), and `makeRecipeScraper(recipe)` turns it into a standard scraper. Six of the
seven portals now run as recipes; adding a new portal is mostly writing a config, not code.
The Settings → Scrapers tab mirrors which portals run as recipes and the strategy stack each uses.

### 6.3 The reconcile / auto-post engine (the closed loop)
This is what turns "10 seconds of human time" into "zero" for the easy cases. It runs on a
loop and does two things:

1. **PB dedup** — for cases stuck mid-workflow, check if the result is *already* on the
   patient's PracticeBetter chart; if so, silently advance the case (no re-upload).
2. **Search → grade → auto-post** — for cases not yet on PB, search the portal by name+DOB,
   download the candidate, and **grade the capture 0–100**:
   - name + DOB exact = +50 (name-only, DOB unverified = +35)
   - exact accession match = +30
   - collection-date proximity = up to +15
   - portal status "Complete" + final date = +15
   - valid PDF ≥ 20KB = +5
   - **Hard disqualifier:** DOB mismatch → instant flag ("wrong-patient risk").

   **Score ≥ 95 → auto-post** (skips the human click); below → stage in Pending Upload and
   flag for review. The threshold is one tunable number (started at 101 = hold everything,
   ratcheted down to 95 as confidence was earned).

Every cycle writes metrics to `lab_engine_runs` (advanced / auto-posted / flagged / searching /
errors) and a separate audit snapshot computes **live PracticeBetter coverage %** (currently
~97%) into `lab_audit_runs`. Both power an **Engine analytics tab**.

### 6.4 The PracticeBetter uploader (+ the IP-block saga)
PB has no public upload API, so the uploader replays the web app's internal API over plain
HTTP: **OAuth password grant → resolve patient → request an S3 upload token → PUT the PDF to
S3 → create the labrequest on the chart**, with CSRF double-submit cookies and a handful of
required headers. The war story: PB **blocks datacenter IPs** (Fly *and* Vercel both get
error 8000 as "known proxy / fraud score"). Webshare residential proxies failed too. The fix:
a clinic ThinkPad runs as a **Tailscale exit node**, and the Fly worker routes only its PB
traffic through that clean residential IP — so the closed loop runs from the cloud while
egressing from the clinic. (The big S3 PUT skips the proxy since pre-signed URLs aren't IP-bound.)

### 6.5 The PB upload job queue
Approvals don't block the UI. Approve (or an auto-post) **enqueues** a `pb_upload_jobs` row;
a worker loop **atomically claims** the oldest job (survives concurrent pollers), downloads the
PDF via a short-lived signed URL, runs the 5-step upload, then **reports** success/failure.
On success it advances the step, cascades to same-accession sibling cards, and fires the
"all labs received" patient workflow. On failure it surfaces a **Retry** button. Classic
enqueue → claim → process → audit pattern.

### 6.6 Zenoti sync
Reads the day's (and near-future) appointments from Zenoti via a cookie session, finds the
`Labs - …` services, maps each to a canonical lab name, and creates/updates tracker cases
keyed on the Zenoti appointment ID (idempotent). Cancelling the appointment soft-deletes the
case on the next tick. Built transport-agnostic so the cookie session swaps for the official
Zenoti API when it lands.

---

## 7. Supporting features

- **Inbound Gmail ingest** — polls `labs@…` for result PDFs and "your results are ready"
  notification emails, parses them with **Claude Haiku** into structured fields, and matches
  them to open cases by confidence. Handles the Kennedy Krieger PDF-by-email exception.
- **Patient email workflow** — Resend-powered templated emails at the right steps, plus the
  **Nadia/Allison** scheduling workflow (Nadia gets a one-click confirm link when all of a
  patient's labs are in; Allison gets the results-review follow-up).
- **Backfill brain** — a 3-script pipeline that took ~424 historical "stuck" cases and
  reconciled them: fill collection dates from a CSV, dedupe duplicate rows, and silently
  advance only the high-confidence matches to "uploaded."
- **AI usage** — Claude Haiku for inbound lab-email parsing and CSV-import normalization;
  Claude Sonnet for **auto-generating new portal scrapers** from a captured HAR. All use
  prompt caching to keep cost low.
- **Cron jobs** — daily stale-case digest, ROF reminders, portal health checks, and a
  **turnaround-learning** job that recomputes each lab's real collection→result timing to keep
  the result-window predictions honest.

---

## 8. The hard technical wins (your "wow" slide)

1. **7 lab portals, each reverse-engineered** — from ExtJS network-intercept to Firebase
   tenant auth to ASP.NET anti-forgery tokens — producing byte-identical PDFs.
2. **The confidence engine** — a transparent 0–100 score that decides auto-post vs. human
   review, with a wrong-patient DOB guard. ~97% PracticeBetter coverage, auto-posting live.
3. **Beating PracticeBetter's datacenter IP block** with a Tailscale exit node — cloud brains,
   clinic egress.
4. **The recipe engine** — new portals are now mostly config, not code.
5. **The visual req-form calibrator** — WYSIWYG field placement, no redeploy.
6. **Defense in depth on patient safety** — accession-first matching, DOB guards, the
   mandatory approve click, append-only audit log on every automated action.

---

## 9. Suggested talk track (10–15 min)

1. **The pain** (1 slide): 7 portals, hundreds of labs, 5 minutes each, wrong-patient = breach.
2. **The idea** (1 slide): human-gated middleware — automate 95%, guard the one dangerous click.
3. **Live demo / the flow** (the spine in §3): walk a card New → Sample Sent → Pending Upload →
   Approve → on the chart. Show the badges and the review modal.
4. **Under the hood** (2–3 slides): the 7 scrapers table, the confidence engine scoring, the
   closed loop + Engine analytics tab (97% coverage).
5. **War stories** (1 slide): Chrome PDF-viewer intercept, Vibrant drip-completeness, the PB
   IP-block / Tailscale fix.
6. **Where it's going**: more auto-posting as the threshold ratchets down, recipe-driven
   portal onboarding, IV-charting tab (next build).

---

## 10. Quick-reference: where things live

| Area | Path |
|---|---|
| Kanban / dashboard | `src/app/labs/LabKanbanBoard.tsx`, `PatientCard.tsx`, `CaseDetail.tsx` |
| PDF review modal | `src/app/labs/PdfReviewModal.tsx` |
| Manage-labs grid | `src/app/labs/PatientLabManager.tsx` |
| Req-form calibrator | `src/app/labs/ReqFormCalibrator.tsx`, `src/lib/req-forms/` |
| Portal scrapers | `worker/src/scrapers/*.ts` |
| Recipe engine | `worker/src/recipes/` |
| Reconcile / auto-post | `worker/scripts/reconcile.ts`, `worker/src/recon/grade.ts` |
| PB uploader | `worker/src/uploaders/practicebetter.ts` |
| FedEx tracking | `src/lib/tracking/refresh-core.ts`, `normalize.ts` |
| Zenoti sync | `worker/src/zenoti/`, `worker/scripts/zenoti-sync.ts` |
| Background loops | `worker/fly.toml` `[processes]` (scrape, pbdrain, tracking, zenoti, reconcile) |
| Worker API | `worker/src/server.ts` |
| App API routes | `src/app/api/**` |
| Architecture docs | `docs/PLAYBOOK.md`, `docs/AUTOMATION_STRATEGY.md`, `docs/RECIPE_ENGINE_DESIGN.md` |
