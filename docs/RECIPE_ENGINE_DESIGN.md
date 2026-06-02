# Lab-portal Recipe Engine — design

Goal: replace hand-written `worker/src/scrapers/<portal>.ts` files with **config-driven
recipes** interpreted by a generic runner, plus a **Settings → Scrapers** UI so portals
can be onboarded/maintained without code. The 7 verified scrapers (Access, Vibrant,
Cyrex, SpectraCell, Genova, GlycanAge, DoctorsData) are the spec and the test cases.

## Key insight from the 7 scrapers

They are NOT all the same shape, but they decompose cleanly along 6 axes. A recipe is
"pick a strategy per axis + fill in its config." Strategies are reusable code; recipes
are data. Adding a portal = a new recipe (data) + only writing new strategy code for a
genuinely novel mechanism.

| Portal | Transport | Auth | Discovery | PDF fetch | Match / Ready |
|---|---|---|---|---|---|
| Vibrant | http | api-token | rest-json | http-get | accession / status |
| GlycanAge | http | firebase (tenant) | rest-json (`/dashboard/reports`) | http-get-stream-slice (`version` exact, slice `%PDF-`) | sample\|name / presence |
| Genova | http | **session-reuse** (storage.json cookies) | rest-json + **CSRF token** (`all-activities`) | http-get (`/webreporting/report?orderNo`) | orderNo\|name+dob / status "Released" |
| DoctorsData | http | aspnet-form (`/LoginUser`, cookie jar) | datatables + **anti-forgery form token** | http-get (row `ReportURL`) | LabID\|name / status "Completed" |
| Access | browser | browser-form (ExtJS) | dom-grid (inbox) | browser-network-intercept (Chrome PDF-viewer trap) | accession\|name+dob / "Complete" |
| Cyrex | browser | browser-form (DNN, 2-field pw reveal) | dom-grid (search → RadGrid) | browser-download-event | requisition\|name+dob / "OnLine" |
| SpectraCell | browser | browser-form (Orchard) | dom-inbox (slow) | browser-download-event (activate row → check → Print Selected) | orderId\|name / "Complete" |

## Recipe schema (shape)

```
LabRecipe {
  labName, key, enabled
  transport: "http" | "browser"
  auth:      { strategy, config }          // firebase | aspnet-form | api-token | session-cookies | browser-form
  discovery: { strategy, config }          // rest-json | datatables | all-activities | dom-grid | dom-inbox
  match:     { refField, nameField, dobField?, refLooksLike? }   // ref-first then name(+dob)
  ready:     { field, equals[] } | { mode: "presence" }
  pdf:       { strategy, config }          // http-get | http-get-stream-slice | browser-download-event | browser-network-intercept
  externalRefField                         // which discovered field becomes labExternalRef
}
```

Each strategy is a small module implementing a typed interface, registered in a catalog.
The runner wires them: `auth → discovery(list) → for each case: match → ready? → pdf`.

- **AuthStrategy**: `authenticate(cfg, ctx) -> AuthState` (cookies/bearer/Playwright page).
- **DiscoveryStrategy**: `list(cfg, auth, ctx) -> Row[]` (normalized: {ref, name, dob?, status?, ...raw}).
- **PdfStrategy**: `fetch(cfg, auth, row, ctx) -> Buffer` (asserts `%PDF-`).

The existing `LabScraper.run(browser, openCases)` contract is unchanged — a single
`makeRecipeScraper(recipe)` produces a `LabScraper`, so `server.ts` registration and the
worker pipeline stay identical.

## Phasing

1. **Phase 1 — HTTP engine** (covers Vibrant, GlycanAge, Genova, DoctorsData = 4/7).
   Build the runner + http transport + auth strategies {firebase, aspnet-form, api-token,
   session-cookies} + discovery {rest-json, datatables, all-activities} + pdf {http-get,
   http-get-stream-slice} + common match/ready. Convert the 4 HTTP scrapers to recipes;
   prove each against its known patient (same as the existing tests). This is the MVP and
   the fastest path to real value.
2. **Phase 2 — Browser engine** (Access, Cyrex, SpectraCell). Add browser transport +
   browser-form auth + dom-grid/dom-inbox discovery + download-event/network-intercept pdf.
   These need per-portal selectors + quirk flags (pw-reveal, slow-waits, activate-row).
3. **Phase 3 — Settings → Scrapers UI** (Next.js). CRUD recipes (DB-backed), a "Test"
   button that runs a recipe against one known case and shows the PDF + matched row, and a
   capture-assist that pre-fills a recipe draft from a HAR. Recipes move from code to DB.

## Non-goals / honest limits

- Not every portal is pure data — novel mechanisms still need a strategy module. The win is
  reuse: most new portals fit existing strategies + config.
- Session-reuse portals (Genova) still need periodic human re-auth (CAPTCHA) — the engine
  models this as an auth strategy that reads a stored session + surfaces "expired" clearly.
- Secrets stay in env / the existing session files, never in recipe data.
