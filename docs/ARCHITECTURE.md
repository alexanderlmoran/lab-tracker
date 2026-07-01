# Architecture & System Map — read this on startup

**Purpose:** one place that says *how the system is wired and where the landmines
are*, so nobody re-investigates a subsystem from scratch to answer "why didn't X
happen?". If you just spent >2 minutes tracing how something works, it belongs
here.

**Relationship to the other docs:**
- `docs/PLAYBOOK.md` — *reuse index*: "before I build a helper, does it exist?"
- **`docs/ARCHITECTURE.md` (this file)** — *structural map + gotchas*: "how does
  data flow, which file owns it, and what silently drops things?"
- `docs/PORTALS.md` — portal registry (URL / login / scraper status per lab).
- `docs/AUTOMATION_MAP.md`, `docs/RECIPE_ENGINE_DESIGN.md` — deeper dives per area.

**How to use it:** skim the Gotchas table first (that's where the re-investigation
cost lives), then jump to the subsystem you're touching. When you learn something
non-obvious about a subsystem, add it to that subsystem's **Gotchas** list — one
line, with the `file:line`.

---

## ⚠️ Gotchas that cause re-investigation (read before debugging)

These are the "why is X not happening?" traps. Each links to its subsystem below.

| Symptom | Cause | Where |
|---|---|---|
| A valid, correctly-named lab appt never becomes a card | Zenoti sync fetches a **therapist-filtered** slice — an appt under an atypical provider is dropped server-side before our code sees it. Must send `strShowAllTherapist:"True"`. | [Zenoti sync](#zenoti--tracker-sync) · `worker/src/zenoti/fetch-browser.ts` |
| Lab appt not syncing | Must (1) start with **`Labs -`**, (2) be within **`ZENOTI_DAYS_AHEAD`** (default 7), (3) be at the **one hardcoded center** (`CENTER_ID`). Miss any → no card, and it won't even appear in the "dropped" log. | [Zenoti sync](#zenoti--tracker-sync) |
| Zenoti sync "just stopped working" after a deploy | `fly deploy` leaves always-on machines **stopped**. Restart each (esp. the `zenoti` machine). | [Deploy ops](#deploy--ops) |
| UI renders dark when the CSS looks light (or vice-versa) | Dark mode = a global CSS `filter: invert()` on the root. **Light CSS renders DARK.** Burned us 3×. | [UI / styling](#ui--styling) |
| PB upload fails with error 8000 | PB blocks known-proxy IPs. Traffic must exit via the clinic ThinkPad Tailscale exit node (`alex-labtop`). Keep it on; `TS_AUTHKEY` ~90d. | [PracticeBetter](#practicebetter-pb-integration) |
| Wrong-patient result on a chart | Result attached without verifying patient. System is now **fail-closed**: auto-post OFF, hardened matcher refuses to guess on missing DOB. | [Integrity & patient safety](#integrity--patient-safety) |
| A scraper returns a login wall / 302 | Portal session cookies expired (~24h Zenoti, varies per portal). Re-run `lab-portal-capture`, `fly secrets set <PORTAL>_SESSION_B64`. | [Portal sessions](#portal-sessions) |

---

## Top-level shape

- **`/` (Next.js 16 on Vercel, `centnerlabs.com`)** — the UI + API. Boards, patient
  pages, Analytics/Integrity, `/api/worker/*` ingest endpoints, `/api/cron/*`.
- **`worker/` (Fly app `lab-tracker-worker`, 9 process groups)** — the automation:
  scraping portals, syncing Zenoti, draining PB uploads, tracking carriers. Each
  Fly **process group** is one machine (`zenoti`, `scrape`, `pbdrain`, `reconcile`,
  `gmailsync`, `tracking`, `ivpost`, `app`, …). See [Deploy ops](#deploy--ops).
- **Supabase** — Postgres (cases, patients_seed, aliases, jobs, statuses) + storage
  (PDFs, direct-upload). **Resend** — email. **Anthropic** — PDF identity / reports.

Data spine: **Zenoti appt → tracker case → scrape result PDF → post to PracticeBetter**,
with reconcile/integrity passes keeping it honest.

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
  which sources the session from `ZENOTI_SESSION_B64`. **TODO: name that entry point here.**

**Key IDs / vars** (`fetch-browser.ts`):
- `ORG_ID = 6219e5ea-…`, `CENTER_ID = dba6b8ae-…` (Brickell). **Single center only.**
- `ZENOTI_DAYS_AHEAD` (default 7), `ZENOTI_SYNC_INTERVAL_MS` (default 60000).
- Session: `ZENOTI_SESSION_B64` secret → decoded at boot (`src/lib/portal-sessions.ts`).

**The gates — an appt becomes a card only if ALL hold:**
1. **`strShowAllTherapist:"True"`** in the setDate body. This is a therapist
   *filter*, not a display toggle. `"False"` returns only the captured session's
   saved book view → appts under other providers vanish **server-side** (won't even
   show in the dropped-service log). Fixed 2026-07-01 (was `"False"`).
2. Service name starts with **`Labs -`** (case-insensitive). `Labs - Vibrant …`,
   `Labs - Access`, etc. → `LAB_MAPPINGS`; unknown `Labs -` → first token fallback;
   `Self Collection` / `Mobile Phlebotomy` → skipped. Anything else → dropped +
   logged `[lab-mapping] dropped unmapped service "…"`.
3. Within **`today … today+DAYS_AHEAD`** (default 7). Further out = invisible until
   it enters the window (bump the env var for more lead time).
4. At **`CENTER_ID`** (one center). Other locations aren't queried.

**How to debug "appt didn't sync":** `fly logs -i <zenoti-machine> --no-tail | grep -iE "dropped|received=|<service>"`.
- Seen in the **dropped** list → gate 2 (rename the Zenoti service to `Labs - …`).
- **Not** in dropped **and** not in `received` → gate 1/3/4 (therapist filter, out
  of window, or wrong center). `received=N` is the total lab appts the fetch found.

**Gotchas:**
- `strShowAllTherapist:"False"` silently drops appts under atypical providers — see gate 1.
- Two sync implementations exist; the loop script is not the live one (see Key files).
- DOB is **not** in the setDate payload — backfilled via `fetchZenotiGuestProfile`
  (V1 API, different host + Bearer token scraped from the page).

---

## Subsystems (to complete — pointers for now)

Each needs the same treatment as Zenoti above (key files, vars, gates, gotchas).
Until filled, the linked doc / memory is the source of truth.

- ### UI / styling
  Dark mode = global CSS `filter: invert()` on root → **light CSS renders dark**.
  Toolbar uses shared `toolbarBtn()` / `ToolbarSelect`. Grid standard: strict
  symmetrical 2-up, header-control pattern, fix clipping *inside* cards.
  *(Fill: component locations, the invert wrapper, the grid helpers.)*

- ### Integrity & patient safety
  Fail-closed after the wrong-patient incident: `AUTO_POST_ENABLED` off, hardened
  matcher refuses to guess without DOB, quarantine on mismatch. Analytics →
  Integrity tab tracks DOB/accession gaps to zero (`getIntegrityReport()`).
  *(Fill: matcher file, gate locations, the reconcile fail-closed path.)*

- ### PracticeBetter (PB) integration
  Uploader = pure HTTP (undici), CSRF double-submit, 4-step API flow. Proxy block
  (err 8000) solved via clinic ThinkPad Tailscale exit node. Tracker is
  *middleware* — stay in sync with PB. *(Fill: uploader file, drain worker, IP-route.)*

- ### Portal sessions & scrapers
  7 portals, each a `storage.json` captured via `lab-portal-capture` →
  `<PORTAL>_SESSION_B64` Fly secret → decoded by `src/lib/portal-sessions.ts`.
  Registry: `docs/PORTALS.md` + `src/lib/scrapers/registry.ts`.
  *(Fill: per-portal auth quirks, the route-intercept PDF trap.)*

- ### Tracking (carriers)
  Multi-carrier (FedEx + UPS). Normalize every scanned value through
  `normalizeScannedTracking`. Tracking # may be kit-out, not sample-return.
  *(Fill: refresh-core flow, carrier detection.)*

- ### Deploy / ops
  `worker/` = Fly (`fly deploy`), `/` = Vercel (auto on push). ⚠️ **`fly deploy`
  leaves always-on machines stopped → `fly machine start <id>` each** (esp.
  `zenoti`). Live prod currently tracks local branch `deploy/audit-fixes`.
  *(Fill: the per-machine restart one-liner, Vercel monorepo tsconfig exclude trap.)*

---

*Started 2026-07-01 while debugging the `strShowAllTherapist` regression. Zenoti
section is complete; the rest are stubs to flesh out.*
