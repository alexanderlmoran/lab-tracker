# Access Medical Labs — Portal Capture (FILLED IN 2026-05-21)

**Status:** captured from live walkthrough. Selectors locked in `worker/src/scrapers/access.ts`.

## Key finding — pivot

**The scraper target is `https://access.labsvc.net/labgen/`, NOT `accessmedlab.com`.**

`accessmedlab.com` is a marketing / account-management Angular app gated by Google reCAPTCHA — automation would be painful and brittle. But the actual lab portal lives on a separate Sencha ExtJS app at `access.labsvc.net/labgen/` (run by Comtron Inc, used by multiple labs). Clicking "Lab Orders & Results" on the AML dashboard is just a static `target="_blank"` link to that URL. The labgen portal has its own login that accepts the same credentials, **no reCAPTCHA, no 2FA**.

The scraper skips accessmedlab.com entirely.

## 1. Login

- **URL:** `https://access.labsvc.net/labgen/`
- **Credentials:** same User ID + password as the AML account (currently `LABSCHB` / `Centner12$` — these MUST be moved into Supabase Vault, never committed)
- **2FA:** none
- **Captcha:** none
- **Form selectors:**
  - User ID input: `input[placeholder="User ID"]` (type=text)
  - Password input: `input[placeholder="Password"]` (type=password)
  - Submit button: `a.x-btn` containing `.icon-login` (ExtJS button, not a real `<button>`)
- **Quirk:** Page sets `window.onbeforeunload = "Your work will be lost!"` — Playwright dialog handler must auto-accept.

**⚠️ Credentials TODO:** Create a dedicated automation account (e.g. `lab-tracker-bot`) before going to production. Using a clinician's personal login is a ban risk.

## 2. Post-login landing

After successful login the page stays on the same URL (SPA). Dashboard becomes visible. Detection: wait for `#maininbox` button to be visible (the "Inbox" tile in the left nav).

Dashboard has a left-rail nav with: Inbox, Search, Patient, Order, Logout, etc. Plus center-of-screen quick-link buttons (Results, Order, Account).

## 3. Results-list page (Inbox)

**Click `#maininbox`** to open the Inbox grid — shows ready/recent results.

(Alternative: `#mainsearch` → "Search Reports" menu item gives a filtered search with date range, patient name, accession #, etc. Use Inbox for default "what's new", Search for matching to specific cases.)

**Grid structure (Sencha ExtJS table):**
- Container: `#tableview-1106` (id is dynamic — use `.x-grid-view` inside `#inbox-1089` or `#inboxgrid-1124`)
- Rows: `table.x-grid-item[data-recordid]`
- Per row columns (in order, by `td:nth-child`):
  1. checkbox (`.x-grid-row-checker`)
  2. **Name** (LAST, FIRST format, e.g. "CENTNER, LEILA")
  3. **DOB** (MM/DD/YYYY)
  4. **Acc#** ← canonical unique ID (8-digit, e.g. `007143558 `)
  5. Ser. Dt (date received)
  6. Col. Dt (date collected/drawn)
  7. Final Dt (date results finalized) — **empty if not ready**
  8. Phys.
  9. **Rep. Status** — contains "Complete" or "Incomplete" + range indicator
  10. Spec. Validity
  11. Ordered Tests (HTML list with per-test "complete"/"partially cancelled" status)

**"Ready" detection:** Rep. Status column contains text "Complete" AND Final Dt column is non-empty.

**Pagination:** none seen in capture (10–12 rows shown). May need infinite scroll handling if the list grows long — TODO verify.

## 4. PDF download

1. Click the row's checkbox cell (`.x-grid-row-checker` inside the target row)
2. Click the "Print Selected reports" button — find by text content (ExtJS IDs are dynamic)
3. Browser triggers a download. Use Playwright `page.waitForEvent("download")` to capture it.

**Filename:** captured PDF filename pattern unknown — TODO log it on first successful run.

**Strategy choice:** select ONE row at a time, download, deselect, next. Multi-select downloads as a combined PDF which would defeat per-case matching. Slower but safer.

## 5. Identification / matching

- **Canonical ID:** `Acc#` (8-digit accession number, e.g. `007143558`)
- **When assigned:** by Access *after* they receive the sample — NOT available at phlebotomy/draw time
- **Matching strategy:**
  - First-time scrape per case: match by patient name + DOB + collection date proximity (Col. Dt ≈ case.sample_sent_at). Capture Acc# into `lab_external_ref` on the case row.
  - Subsequent scrapes: O(1) lookup by `lab_external_ref`.
- **Note:** the Order# (different from Acc#) does appear at order-creation time and may be capturable from the AML side at draw, but capture didn't cover that flow. TODO if first-time match accuracy is poor.

## 6. Volume + cadence (not yet captured)

Estimated from the inbox snapshot: ~10–15 results/week visible at any time, with daily new arrivals. Hourly cron cadence is appropriate.

## 7. Anti-automation signs

None observed. ExtJS app, no captcha, no rate-limit warnings, beforeunload prompt only.

## 8. Stable selector cheat sheet (locked into scraper)

| Action | Selector |
|---|---|
| Login URL | `https://access.labsvc.net/labgen/` |
| Username input | `input[placeholder="User ID"]` |
| Password input | `input[placeholder="Password"]` |
| Login button | `a.x-btn:has(.icon-login)` |
| Open Inbox | `#maininbox` |
| Row scope | `table.x-grid-item[data-recordid]` |
| Row checkbox | `.x-grid-row-checker` |
| Name cell | `td:nth-child(2)` within row |
| DOB cell | `td:nth-child(3)` |
| Acc# cell | `td:nth-child(4)` |
| Col. Dt cell | `td:nth-child(6)` |
| Final Dt cell | `td:nth-child(7)` |
| Status cell | `td:nth-child(9)` |
| Print button | `a.x-btn:has-text("Print Selected reports")` |

**Warning:** Sencha ExtJS generates dynamic IDs like `textfield-1050` that change between sessions / versions. Always prefer `placeholder`, `class`-based, or text-content selectors. Never select by autogenerated id.
