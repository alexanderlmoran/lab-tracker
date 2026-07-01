# Architecture & System Map — read this on startup

**Purpose:** one place that says *how the system is wired and where the landmines
are*, so nobody re-investigates a subsystem from scratch to answer "why didn't X
happen?". If you just spent >2 minutes tracing how something works, it belongs
here.

**The doc web (read in this order):**
- **`docs/ARCHITECTURE.md` (this file)** — *structural map + gotchas*: how data
  flows, which file owns it, and what silently drops things.
- **`docs/INCIDENTS.md`** — *the lessons ledger*: every past bug/gap since go-live,
  its root cause, and the guardrail that now prevents recurrence (or "still a risk").
- **`docs/DB_HARDENING.md`** — *make it structural*: where safety is code-only and
  the exact DB constraints that would make regressions impossible + the prod-drift
  verification checklist.
- `docs/PLAYBOOK.md` — *reuse index*: "before I build a helper, does it exist?"
- `docs/PORTALS.md` — portal registry (URL / login / scraper status per lab).
- `docs/AUTOMATION_MAP.md`, `docs/AUTOMATION_STRATEGY.md`, `docs/RECIPE_ENGINE_DESIGN.md`
  — deeper dives per area.

**How to use it:** skim the Gotchas table first (that's where the re-investigation
cost lives), then jump to the subsystem you're touching. When you learn something
non-obvious, add it to that subsystem's **Gotchas** list — one line, with `file:line`.

---

## ⚠️ Gotchas that cause re-investigation (read before debugging)

Each links to its subsystem below. Incident numbers reference `docs/INCIDENTS.md`.

| Symptom | Cause | Where |
|---|---|---|
| A valid, correctly-named lab appt never becomes a card | Zenoti sync fetches a **therapist-filtered** slice — an appt under an atypical provider is dropped server-side. Must send `strShowAllTherapist:"True"`. (#9) | [Zenoti sync](#zenoti--tracker-sync) |
| Lab appt not syncing | Must (1) start with **`Labs -`**, (2) be within **`ZENOTI_DAYS_AHEAD`** (7), (3) be at the **one hardcoded center**. Miss any → no card, no trace. | [Zenoti sync](#zenoti--tracker-sync) |
| Zenoti/scrape/IV sync "just stopped" after a deploy | `fly deploy` leaves always-on machines **stopped**. Fix: `fly deploy && bash scripts/start-all-machines.sh`. (#23) | [Deploy / ops](#deploy--ops) |
| UI renders dark when the CSS looks light | Dark mode = global CSS `filter: invert(1) hue-rotate(180deg)` on root. **Light CSS renders DARK.** Burned us 3×. (#29) | [UI / styling](#ui--styling) |
| PB upload fails / PDF stuck in Pending forever | PB blocks datacenter IPs (err 8000). Traffic must exit via the clinic ThinkPad Tailscale node (`PB_PROXY_URL`). `TS_AUTHKEY` ~90d. (#21) | [PracticeBetter](#practicebetter-pb-integration) |
| Wrong-patient result on a chart | Result attached without a verified tie. Now fail-closed: accession-exact OR corroborated name, else quarantine. (#1) | [Integrity & safety](#integrity--patient-safety) |
| The wrong-patient guard **silently does nothing** | It reads `lab_case_pdfs.report_patient_name`; if that hand-applied migration never hit prod, null never blocks. **Verify the column exists on prod.** | [DB_HARDENING.md](DB_HARDENING.md) |
| Same accession on two different patients | The DB does **not** enforce one-accession-one-patient (`lab_external_ref` is a non-unique index). Detective control only (Integrity tab). | [DB_HARDENING.md](DB_HARDENING.md) |
| Vercel build fails on worker TS / `tsx` not found | Root `tsconfig.json` must `exclude: ["worker"]` (line 33). (#19) | [Deploy / ops](#deploy--ops) |
| A scraper returns a login wall / 302 | Portal session cookies expired (~24h Zenoti). Re-run `lab-portal-capture`, `fly secrets set <PORTAL>_SESSION_B64`. | [Portal sessions](#portal-sessions--scrapers) |

---

## Top-level shape

- **`/` (Next.js 16 on Vercel, `centnerlabs.com`)** — UI + API. Boards, patient
  pages, Analytics/Integrity, `/api/worker/*` ingest endpoints, `/api/cron/*`.
- **`worker/` (Fly app `lab-tracker-worker`, 9 process groups)** — the automation.
  Each Fly **process group** is one machine: `app` (scale-to-zero HTTP), and the
  always-on loops `zenoti`, `scrape`, `pbdrain`, `reconcile`, `tracking`, `ivpost`,
  `gmailsync`. See [Deploy / ops](#deploy--ops).
- **Supabase** — Postgres (cases, patients_seed, aliases, jobs, statuses) + storage
  (PDFs). **Resend** — email. **Anthropic** — PDF identity / reports.

Data spine: **Zenoti appt → tracker case → scrape result PDF → post to PracticeBetter**,
with reconcile/integrity passes keeping it honest. There is **no canonical patient
table** — patient identity is denormalized onto every `lab_cases` row (see
[DB_HARDENING.md](DB_HARDENING.md) for why that matters for safety).

---

## Zenoti → tracker sync

**What it does:** turns Zenoti lab appointments into tracker cases.

**Key files:**
- `worker/src/zenoti/fetch-browser.ts` — the transport. `fetchZenotiApptRows()`
  POSTs `ApptExtV2.aspx/setDate` (one day at a time) with the captured session
  cookies; `fetchZenotiLabAppointments()` filters to lab services;
  `fetchZenotiGuestProfile()` pulls DOB/sex/address from the V1 REST API.
- `worker/src/zenoti/lab-mapping.ts` — `resolveLabName()`: which services become cards.
- `worker/scripts/zenoti-sync-loop.ts` — a standalone loop (today→+`DAYS_AHEAD`).
  ⚠️ **Not the live entry point on Fly** — its hardcoded `captures/…/storage.json`
  path isn't shipped in the image. The live `zenoti` machine runs the combined
  orchestrator (logs `tracker: received=… / iv: … / consumables: …` every ~3 min)
  which sources the session from `ZENOTI_SESSION_B64`. **TODO: name that entry point.**

**Key IDs / vars** (`fetch-browser.ts`):
- `ORG_ID = 6219e5ea-…`, `CENTER_ID = dba6b8ae-…` (Brickell). **Single center only.**
- `ZENOTI_DAYS_AHEAD` (default 7), `ZENOTI_SYNC_INTERVAL_MS` (default 60000).
- Session: `ZENOTI_SESSION_B64` secret → decoded at boot (`src/lib/portal-sessions.ts`).

**The gates — an appt becomes a card only if ALL hold:**
1. **`strShowAllTherapist:"True"`** in the setDate body. This is a therapist
   *filter*, not a display toggle. `"False"` returns only the captured session's
   saved book view → appts under other providers vanish **server-side** (won't even
   show in the dropped-service log). Fixed 2026-07-01 (was `"False"`). (INCIDENTS #9)
2. Service name starts with **`Labs -`** (case-insensitive). `Labs - Vibrant …`,
   `Labs - Access`, etc. → `LAB_MAPPINGS`; unknown `Labs -` → first-token fallback;
   `Self Collection` / `Mobile Phlebotomy` → skipped. Anything else → dropped +
   logged `[lab-mapping] dropped unmapped service "…"`. (INCIDENTS #16)
3. Within **`today … today+DAYS_AHEAD`** (default 7). Further out = invisible.
4. At **`CENTER_ID`** (one center). Other locations aren't queried.

**Debug "appt didn't sync":** `fly logs -i <zenoti-machine> --no-tail | grep -iE "dropped|received=|<service>"`.
- In the **dropped** list → gate 2 (rename the Zenoti service to `Labs - …`).
- **Not** in dropped **and** not in `received` → gate 1/3/4. `received=N` is the total.

**Gotchas:** the therapist filter (#9); two sync implementations (loop script ≠ live);
DOB isn't in the setDate payload (backfilled via `fetchZenotiGuestProfile`, a
different host + Bearer token scraped from the page).

---

## UI / styling

**Purpose:** consistent themeable UI via a *global CSS inversion filter*, shared
toolbar controls, and strict 2-up card grids.

**Key files:**
- `src/app/globals.css:86-109` — dark mode: `html.dark { filter: invert(1) hue-rotate(180deg) }`
  on root, plus re-inversion for media (`img/video/canvas/iframe/[data-no-invert]`)
  and `dialog` so they render as authored.
- `src/app/labs/ThemeToggle.tsx:13-44` — toggles the `dark` class on `<html>`,
  persists to `localStorage["labTheme"]`; a boot script in `app/layout.tsx` re-applies
  before first paint to prevent flash.
- `src/app/labs/toolbar-styles.ts:9-21` — `toolbarBtn(active)`, the ONLY source of
  toolbar-control classnames. `src/app/labs/ToolbarSelect.tsx` — shared dropdown
  (replaces native `<select>`), uses `toolbarBtn()`.
- `src/app/labs/CaseCard.tsx:102-125`, `CaseDetail.tsx` (`lg:grid-cols-2`) — the
  strict-light card shell (`bg-white border-zinc-200`) + 2-up grid standard.
- `src/app/labs/hud.css:332-390` — `.kanban-col` gradient/borders via CSS vars.

**Invariants:** (1) everything is styled **light**; the root filter flips luminance;
`hue-rotate(180)` keeps brand colors readable. (2) real media / dialogs must escape
the filter (re-inverted). (3) all toolbars use `toolbarBtn()` — no ad-hoc button
colors. (4) detail layouts are `lg:grid-cols-2`, action top-right, clip *inside* cards.

**Gotchas:** **light CSS renders dark** — never hardcode `bg-blue-500` (inverts to
cyan); use `bg-white`/`bg-zinc-*` and let it flip (#29). The root filter makes the
page a containing block for `position:fixed` → popovers can clip; use the
fixed-from-`getBoundingClientRect()` pattern (`SortControl`) or the Popover top-layer
(#30). Boot script must run pre-hydration or the light SSR HTML flashes.

---

## Integrity & patient safety

**Purpose:** fail closed. Auto-post is OFF by default; the hardened matcher refuses
to guess a patient without DOB; a result is quarantined without a verifiable tie.
This is the machinery that stops the 2026-06-24 wrong-patient class of bug (#1).

**Key files:**
- `src/lib/labs/integrity.ts:43-103` — `getIntegrityReport()`: the single source of
  truth for gaps. Scans active `lab_cases` → `dobGaps`, `accessionGaps`, `collisions`
  (same accession, different patient). `labNeedsAccession()` skips Peptides / Mobile
  Phlebotomy / Self Collection. Surfaced in `analytics/IntegrityView.tsx`.
- `src/app/api/worker/result-ready/route.ts` — the server chokepoint:
  - `:140-156` last-name mismatch → **409 + loud log** (no silent skip).
  - `:199-232` **fail-closed quarantine**: accept only if accession-exact OR
    `report_patient_name` corroborates; else quarantine + 409.
  - `:303-320` DOB backfill from the PDF, scoped to **name+email** (never email alone).
  - `:474-484` **`AUTO_POST_ENABLED` gate** (default off).
- `worker/src/uploaders/practicebetter.ts:272-351` — `findPbPatient()`: name-first,
  email-fallback guarded by surname+first-initial, **returns null (refuses to guess)**
  when DOB matches none / multiple candidates remain. `createPbPatient()` only when
  genuinely new (no same-name OR same-email chart).
- `src/app/labs/import/actions.ts:80-142` — `matchPatientToCache()`: exact_one /
  ambiguous (operator picks) / none. No auto-guess between same-name charts.

**Invariants:** DOB disambiguates same-name charts (no DOB → hold). Accession is the
exact-order tie. Accession collisions = wrong-patient hazard (red on Integrity tab).
Auto-post OFF unless the env flag is `"true"`. Same-accession siblings never
double-post.

**Gotchas:** every guard here is **code-only** — a direct/service-role insert into
`lab_case_pdfs` bypasses all of it, and the whole thing hinges on the
`report_patient_name` column existing on prod (see [DB_HARDENING.md](DB_HARDENING.md),
INCIDENTS #1). Email-only matching is the **family trap** (#3): shared parent email
matches a sibling — the guard is surname+first-initial. DOB backfill does NOT reach a
same-name/different-email family member (intentional).

---

## PracticeBetter (PB) integration

**Purpose:** upload result PDFs to PB charts via a pure-HTTP 4-step flow, persist the
resolved PB chart id on the case, and dodge PB's datacenter-IP block via a Tailscale
residential exit node.

**Key files:**
- `worker/src/uploaders/practicebetter.ts` — the library. `pbLogin()` (OAuth password
  grant) → `findPbPatient()` (hardened, see above) → `requestUploadToken()` (pre-signed
  S3) → `uploadPdfToS3()` (direct, NOT proxied) → `createLabRequest()` (published +
  notify). `uploadPdfToPb()` orchestrates; `withPbReauth()` self-heals one 401.
  `:32-44` PB-domain traffic routes through `PB_PROXY_URL` (ProxyAgent); S3 does not.
- `worker/scripts/pb-upload-worker.ts` — the `pbdrain` machine: `claimNext()` →
  `processJob()` (download PDF to /tmp, upload, report result). Poll `PB_WORKER_INTERVAL_MS`.
- `src/app/api/worker/pb-upload/next/route.ts:129-161` — claim endpoint + **outbound
  patient guard** (no override path — an overridden mismatch parks as failed; see #1).
- `src/app/api/worker/pb-upload/result/route.ts:76-200` — on success flip
  `step5`, persist `lab_cases.practicebetter_record_id` (`:94`), cascade same-accession
  siblings; on failure record error + "Retry".

**Key vars:** `PB_BASE=my.practicebetter.io`, `PB_CLIENT_ID` (public), `PB_USERNAME/PASSWORD`,
`PB_PROXY_URL` (SOCKS5 to clinic ThinkPad exit node), `TS_AUTHKEY` (~90d). Queue:
`pb_upload_jobs` (queued/claimed/succeeded/failed).

**Invariants:** 4 steps sequential & atomic per job; single session reused; S3 not
proxied; labrequest published + notifies patient; **one drain machine** (no races);
resolved PB id persisted for future posts.

**Gotchas:** **err 8000 = datacenter-IP block** — `PB_PROXY_URL` MUST be set on prod
or every login fails silently and the PDF sits in Pending forever (#21). `TS_AUTHKEY`
lapse → connection timeout (not a clear error); the daily digest warns N days ahead.
Fuzzy PB search can miss an existing chart → duplicate chart risk; the Settings
post-test `expectedPatientId` guard aborts before any write.

---

## Portal sessions & scrapers

**Purpose:** materialize base64 session cookies at boot, feed a registry of 7 lab
scrapers, and intercept inline-PDF responses before Chrome's viewer eats them.

**Key files:**
- `worker/src/lib/portal-sessions.ts:22-49` — `materializePortalSessions()` decodes
  `*_SESSION_B64` → `/tmp/portal-sessions/*.json` at boot (idempotent, best-effort);
  an explicit `*_SESSION_PATH` overrides. Called from `worker/src/server.ts:19`.
- `worker/src/recipes/catalog.ts` — `RECIPES[]`: GlycanAge, DoctorsData, Genova,
  Cyrex, Spectracell, Access (config-driven, http|browser). `runner.ts` →
  `makeRecipeScraper()`. Hand-written: `worker/src/scrapers/*.ts` (Vibrant + the six).
- `worker/src/recipes/strategies-browser.ts:185-228` — `browserNetworkInterceptPdf()`:
  `ctx.route()` buffers the PDF POST mid-flight, then `route.fulfill()` replays it.
- `worker/src/scrapers/base.ts:11-18` — `normalizeDob()`: one DOB normalizer for all
  scrapers (unpadded US dates historically caused wrong-patient misses, #17).

**Invariants:** session decode idempotent + best-effort (bad secret → skip, not crash);
recipe portals need all 3 stages (auth/discovery/pdf); DOB match uses the shared normalizer.

**Gotchas:** the **Chrome-PDF-viewer trap** (route-intercept, per `lab-portal-capture`
skill). Genova login is reCAPTCHA+MFA → human-only, session reused via `GENOVA_SESSION_PATH`.
Golda is manual-only (8/8 auto-scrape failures). Session refresh = re-run capture →
`fly secrets set <PORTAL>_SESSION_B64="$(base64 -i storage.json)"` (Fly auto-restarts).
See `docs/PORTALS.md` + `docs/RECIPE_ENGINE_DESIGN.md` + `docs/ACCESS_PORTAL_CAPTURE.md`.

---

## Tracking / carriers

**Purpose:** detect carrier from a scanned number, poll FedEx+UPS, normalize status,
auto-advance sample-sent, predict result date on delivery.

**Key files:**
- `src/lib/tracking/normalize.ts:21-59` — `normalizeScannedTracking()` (slice the real
  12 digits out of the 34-char FedEx "96" barcode / 22-char SSCC) + `detectCarrier()`
  (`1Z…` → UPS, else FedEx). **Every scan site must route through this** (#15).
- `src/lib/tracking/refresh-core.ts:169-288` — `refreshTrackingForActiveCasesCore()`:
  active cases → chunk ≤30 FedEx + concurrent UPS → `mergeUpdate()` → DB. `:42-106`
  `onDeliveredTransition()` ticks step1 + fills expected-result dates.
- `src/lib/labs/carrier.ts:8-16` — outbound carrier (`tracking_carrier` wins, else
  Cyrex→UPS, else FedEx).
- `src/app/api/cron/refresh-tracking/route.ts:50-73` — heartbeat: `errors>0 && polled=0`
  = FedEx outage → flips `consecutive_failures` (previously stayed green → 9-day
  silent outage, #24).

**Invariants:** poll only non-delivered, non-deleted cases; a stale "unknown" never
regresses a "delivered"; step1 ticks on first in-transit (proof it shipped); expected
dates fill only when both are blank + the lab has a turnaround entry.

**Gotchas:** a tracking # may be the kit-**out** shipment, not the sample-return, and
FedEx recycles numbers — needs name+carrier corroboration; nothing hard-blocks a
mis-corroborated advance (open risk). See `docs/AUTOMATION_MAP.md` "The feed".

---

## Deploy / ops

**Purpose:** two targets — `worker/` on Fly, `/` on Vercel.

**Key files:** `worker/fly.toml` (app `lab-tracker-worker`, region `iad`, the 9
process groups; `:34-37` the deploy WARNING). `worker/scripts/start-all-machines.sh`
(post-deploy restart, idempotent). `tsconfig.json:33` (`exclude: ["worker"]`).
`vercel.json` (8 crons). Secrets: `WORKER_SHARED_SECRET`, `TRACKER_BASE_URL`,
per-portal creds, `ZENOTI_SESSION_B64`, `PB_PROXY_URL`, `TS_AUTHKEY`, `CRON_SECRET`.

**Process groups:** `app` scales to zero (http_service); `zenoti`, `scrape`, `pbdrain`,
`reconcile`, `tracking`, `ivpost`, `gmailsync` are **always-on**.

**The two footguns (both real, both ship-blocking):**
1. **`fly deploy` leaves always-on machines STOPPED** (#23). `auto_start_machines`
   only applies to `http_service.processes = ["app"]`. Silent multi-day sync outage.
   **Remedy — every deploy:** `cd worker && fly deploy && bash scripts/start-all-machines.sh`.
   Backstop: the heartbeat watchdog (`/api/cron/heartbeat-watch`) emails ≤1 day later.
2. **Vercel monorepo tsconfig trap** (#19): root tsconfig must `exclude: ["worker"]`
   or Vercel type-checks the Fly worker and the build dies. Also: **no non-async
   `export` from a `"use server"` file** — tsc can't catch it; only `next build` does
   (this class caused prod-wide 404s, #18). Run a full `next build` before deploy.

**Other:** PB egress (`pbdrain`/`reconcile`/`ivpost`) wraps startup with
`pb-egress-entrypoint.sh` (Tailscale). `TS_AUTHKEY` ~90d. Vercel Hobby caps crons at
1/day → the worker `tracking` loop fills the gap. See `docs/SESSION_HANDOFF.md`.

---

*Complete map as of 2026-07-01 (built from a 5-agent audit). Subsystem sections are
verified against code with file:line. Keep them current: when a `file:line` moves or
a new gotcha bites, edit the relevant section. Incidents → `docs/INCIDENTS.md`;
structural fixes → `docs/DB_HARDENING.md`.*
