# Playbook — reuse before you rebuild

**READ THIS BEFORE WRITING NEW CODE.** Most "new" problems in this repo were
already solved once. The cost of not checking is real: the FedEx barcode
last-12-digit logic was rebuilt by chasing the symptom when
`normalizeScannedTracking` had existed for weeks — a full test cycle wasted.

How to use this file:
1. **Before building any utility, transform, or parser**, `grep` the codebase
   for the concept AND skim the table below. Prefer extending an existing
   helper over writing a parallel one.
2. **When you solve something non-obvious**, add a one-line row here pointing at
   the file. This file is the index; the code is the source of truth.
3. Cross-link: each domain doc (below) links back here; this links to them.

---

## Reusable logic — check here first

| Need | Use this (don't rebuild) | Lesson |
|------|--------------------------|--------|
| Barcode scan → clean tracking # | `normalizeScannedTracking` — `src/lib/tracking/normalize.ts` | FedEx label's big barcode is a 34-digit "96" string; the tracking # is the last 12 digits. Run **every** scanned tracking value through it. |
| Free-text lab name → scraper portal | `normalizeLabName` / `sameLab` / `probeKeyForLab` — `src/lib/scrapers/normalize-lab.ts` | Staff type "Access Custom", "Vibrant · EBOO". Match on the canonical portal, never raw string equality. |
| Display a case's lab + panel | `labelForCase` / `panelFor` — `src/lib/labs/label.ts` | Zenoti multi-panel tests store `lab_name="Vibrant"`, `lab_panel=null`; the panel lives in `zenoti_service_name`. Recover it for display. |
| Zenoti service → lab_name (+panel) | `resolveLabName` — `worker/src/zenoti/lab-mapping.ts` | "Labs - X" prefix triggers a case; canonical map first, token-split fallback. (TODO: also return the panel.) |
| Advance step on tracking | step 1 ("Sample sent") auto-ticks when a tracking # is added — `updateLabCase`, `bulkUpdatePatientCases`, `attachTrackingFromScan`, and `refresh-core` (on in-transit). | A card with a live tracking # should never sit in "untouched". Keep all entry paths consistent. |
| Edit many of a patient's labs at once | `ManageLabsButton` grid — `src/app/labs/PatientLabManager.tsx` | Patient cards group by **email**; a shared-email family needs the Who-column/per-person scoping. |
| Find a result with no accession | probe — `POST /probe/:lab?name=` (`worker/src/server.ts`) → `probeCaseResult` (`src/app/labs/probe-actions.ts`) | Scrapes the portal by patient name; empty = "not ready yet". The modern replacement for the dead lab-adapters. |
| Read/patch prod case state from a script | debug endpoint `GET/PATCH /api/worker/debug/cases` (Bearer `WORKER_SHARED_SECRET`) | Worker scripts (`worker/scripts/*`) talk to prod through this, not Supabase directly. Actions: archive, soft/hard-delete, set-collection-date, advance-step1, advance-step5. |
| Poll FedEx + advance/predict | `refreshTrackingForActiveCasesCore` — `src/lib/tracking/refresh-core.ts` | Cron-or-button. Advances on in_transit (not pre_transit) and on delivered (which also predicts result dates). |
| Run the result pipeline | Fly `[processes]` loops in `worker/fly.toml`: `scrape` (scrape-all --loop → stage PDFs), `pbdrain` (post APPROVED PDFs to PB), `tracking`, `zenoti`. | Background jobs MUST be a supervised `[processes]` loop or they don't run. A code path existing ≠ scheduled (scrape-all + pb-drain + refresh-tracking were all built but unscheduled for weeks). After adding a process group, `fly deploy` then confirm it's in `fly scale show`. |
| Which cases are scrapeable | `/api/worker/open-cases` — accession set + (results received OR in result-window) + not on PB. | The scraper matches by accession only (patient-safe), so probing an in-window not-yet-ready case is a safe no-op; `postResultReady` auto-marks step4 when a PDF is found. |
| Position / add fields on a req-form template | Calibrate visually — drag fields in `ReqFormCalibrator.tsx`; positions + user-added custom fields persist via `req-forms/overrides.ts` (`{fields, custom}` JSON in the templates bucket) and `fillReqForm` merges them over `specs.ts`. | Don't hand-tune coords in `specs.ts` by eyeballing previews, and don't add a field type for every missing box — the calibrator's "+ Add field" lets staff drop+label+type their own. SVG `<text>` is anchored at its alphabetic baseline = pdf-lib's `drawText` anchor, so the overlay is WYSIWYG. ⚠️ pdf.js: load via NATIVE dynamic import (`new Function("u","return import(u)")`) of the self-hosted **legacy** build at `/pdfjs/pdf.min.js` — letting the app bundler re-process `pdfjs-dist` throws "Object.defineProperty called on non-object". `/pdfjs/` (copied by `copy-pdf-worker` prebuild/predev) is excluded from the auth proxy. Overrides are live; bake settled numbers back into `specs.ts`. Per-form `dateSep` spaces date digits to clear MM/DD/YYYY divider boxes. |

## The 7 portal scrapers (don't add an 8th pattern — copy one)
Built via the recipe engine (`worker/src/recipes/`) or hand-written. All
verified byte-equivalent. To add a portal: `/lab-portal-capture` skill →
HAR capture → recipe. Gotcha index lives in each capture folder + the memory.
Portals: Access, Cyrex, Spectracell, Genova, GlycanAge, DoctorsData, Vibrant.

## Dead code — do NOT extend
- `src/lib/lab-adapters/` (LabCorp/Quest) — the old "pull status" system. The
  real portals have worker scrapers + the probe. The "Refresh lab status"
  button is only meaningful if `getAdapterFor` returns non-null.

---

## Domain docs (deeper dives)
- [Automation strategy](AUTOMATION_STRATEGY.md) — human-gated middleware model
- [Recipe engine design](RECIPE_ENGINE_DESIGN.md) — config-driven scrapers
- [E2E test runbook](E2E_TEST_RUNBOOK.md) — full pipeline lifecycle
- [Backfill brain runbook](BACKFILL_BRAIN_RUNBOOK.md) — date/dedupe/step5 scripts
- [Access portal capture](ACCESS_PORTAL_CAPTURE.md) — scraper capture walkthrough

## Operational gotchas (bit us before)
- **Worker scripts hit PROD** (`.env.local` → `TRACKER_BASE_URL` = Vercel). A
  localhost dev server also reads `.env.local` → talks to prod Supabase.
- **FedEx is prod-only**: keys live in Vercel, not `.env.local`; Vercel cron
  doesn't run locally. Test FedEx on the deployed app.
- **Vercel is on Hobby** → crons run **once/day max**. For higher cadence,
  schedule from the Fly worker (no plan cap) hitting the cron endpoint.
- **Root `tsconfig.json` must exclude `worker/`** or Vercel builds break.
- Multi-panel Zenoti tests (Vibrant Zoomer) arrive as N services → N cards
  sharing one kit/accession. That's expected, not a duplicate.
