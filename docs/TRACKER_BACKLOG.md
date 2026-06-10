# Lab Tracker — Backlog & Notes

Raw brain-dump from Alex (captured 2026-06-09) for a clean restart. Grouped by
theme; original intent preserved. Lines marked _(ptr: …)_ are pointers I added
to where the relevant code likely lives — verify before trusting.

---

## 🐞 Bugs

1. **Zenoti deletion not syncing.** When an appointment is deleted in Zenoti, the
   tracker case is NOT deleted. _(ptr: deletion-reconciliation already exists in
   `src/app/api/worker/cases/route.ts` via the `syncedDates` census + `RECONCILE_GRACE_MS`;
   verify the Zenoti sync is actually POSTing a COMPLETE per-day census, and that
   the zenoti machine/loop is running — see `worker/scripts/zenoti-sync.ts`.)_

2. **Tracking# auto-completes "Sample sent" (should be MANUAL).** Inputting a
   tracking number into the Sample-sent column auto-ticks step 1; Alex wants that
   to be manual. _(ptr: currently auto-ticks — PLAYBOOK row "Advance step on
   tracking" → `updateLabCase` / `bulkUpdatePatientCases` / `attachTrackingFromScan`
   / `refresh-core`. Decouple tracking-entry from step1.)_

3. **Merge dupes doesn't move cards together.** Moved Vanessa LeBlanc — moved ONE
   card to a column, the others didn't follow. Need an option to **move all / by
   type / selected** when moving a patient's cards.

4. **Merged-dupes ghost card.** Merging dupes for Vibrant showed "3 merged" but
   left a copy/ghost card for Vanessa LeBlanc.

5. **DOB not captured from Zenoti** (e.g. Vanessa LeBlanc). _(ptr: Zenoti `setDate`
   appt data does NOT expose DOB — confirmed during IV charting; needs a Zenoti
   guest-detail lookup or manual entry. `patients_seed` holds DOB where known.)_

6. **Pending Upload worker stagnant** for Daniel Tzinker — "continuously searches"
   but stuck. Add a per-card **manual "refresh / search for lab to post (review
   PDF)"** button. _(ptr: scrape via `/api/worker/open-cases` + probe; see PLAYBOOK
   "Which cases are scrapeable".)_

7. **Req-form issues** (Kennedy / DoctorsData / Spectracell). Ordered KK but it
   didn't pull into the req form from the tracker; re-entered the order # and it
   still didn't show on the req. Issues with "redraw" + "some other things".
   → **Suggestion: move req-form calibration/testing into Settings** so it can be
   calibrated + tested anytime. _(ptr: `ReqFormCalibrator.tsx`, `req-forms/`.)_

---

## 🗂️ Kanban columns, steps & wording

8. **Rename "Partial uploaded" column → "Pending Upload"**, and add a **search for
   labs** inside Pending Upload.

9. **Step names should match column names.** "Step 10 Completed" is missing;
   review the wording of ALL steps for consistency with the columns. _(ptr:
   `STEP_TO_DB_COL` in `src/app/labs/actions.ts` defines steps 1–9.)_

10. **Activity log: plain English + signal over noise.** Too many notes — surface
    only the major/important events, and replace raw enum strings with plain
    English. Example raw events to humanize:
    - `Step 1 uncompleted`
    - `expected_dates_set — Predicted: 2026-07-29 to 2026-08-16`
    - `Step 1 completed`
    - `Edited: collection_date, tracking_number, lab_external_ref`
    - `Case created — Auto-created from Zenoti appointment <id> • Labs - Vibrant Zoomer - Toxin` (actor `worker:zenoti-sync`)

    _(Possibly the same intent behind his earlier "tracking refresh too much after
    delivered" / "card activity has too many notes".)_

---

## ✉️ Email automation (confirm + fix)

11. **Confirm tracker emails auto-send on step moves.** Had to manually press
    "email" + send for **Allison C.** today. Confirm BOTH the tracker email AND
    the PB email automation actually fire on the right step transitions.

12. **Nadia's email targets the wrong thing.** Currently notifies HER; it should
    notify the **remaining/outstanding labs for the GROUP**. (Ties to grouping.)
    _(ptr: see `project_lab_tracker_nadia_allison` memory — Nadia fires when ALL
    patient labs at step 5.)_

13. **Kennedy → Centner → BodyBio email automation** — confirm it works + show
    **proof in the inbox**.

14. **labs@centnerhb.com** — check daily to post; Kennedy is probably the same flow.

15. **Inbox + UI notifications.** Add inbox notifications AND **main-page UI
    notifications for new emails**. If Allison (or any patient) sends labs, surface
    them to post previously-done labs to the PB account → automate eventually.

---

## 👥 Patient grouping & merge

16. **Group a patient's labs by DATE.** Patients do **2–7 labs at a time**; group
    them (likely by collection date). ("group by date?" noted several times —
    e.g. 6 tests same date.)

17. **Add "Merge patients" and "Merge by date"** (we already have "merge dupes").

18. **"Manage labs" — view by date/group.** Clicking a card → Manage labs shows
    **every lab ever done** (Leila = case study, shows everything). Need to filter
    by date/group. _(ptr: `PatientLabManager.tsx`.)_

19. **"Manage labs" bulk actions.** Add **"Also mark all as Sample sent (no
    emails)"** + a **"Save all (6+ sent)"** action; currently there's no
    save-only option. Prefer the **3-colored-buttons style** (bottom-right) used
    in the PDF review modal.

---

## 🔬 Scraping / result prediction

20. **Access partials — staged completion checks.** Access returns partials;
    schedule completion checks on **day 2, day 4–7, and day 14**. _(ptr:
    result-date prediction + scrape scheduling; turnaround learning cron.)_

21. **"Complete upload notification."** Add a notification when a complete upload
    happens. (Not expanded.)

---

## 🗄️ Records portal / historical backfill

22. **Historical backfill + in-app records portal.** Pull records of ALL labs by
    ALL patients from **June 2025 → now** for record-keeping, so there's an in-app
    portal to check **without referencing PB or Zenoti**.

---

## ✏️ Editing / patient data

23. **Edit DOB on the "edit lab card" dialog** — and **save it to the PATIENT**
    (for prefilled use elsewhere, e.g. req forms). Related to Bug #5 (DOB not
    captured from Zenoti).

---

## 📦 Pickup scheduling

24. ~~**"Schedule pickup (109)" — count is wrong + confirm one-call behavior.**~~
    ✅ **FIXED 2026-06-09.** The count was every active card with a tracking #
    that was never booked through the app (all shipped/delivered/backfilled
    history), and ALL of them were pre-selected in the dialog. Now:
    - Candidates come from `awaitingPickup()` (`src/lib/labs/pickup.ts`):
      tracking # present, no pickup booked, **package not yet scanned into the
      FedEx network**, and no results back.
    - Confirmed: one "Book pickup" click = **one** FedEx API call
      (`POST /pickup/v1/pickups`, `packageCount` = selected count), stamping
      only the cards you checked. No cron/worker books pickups.
    - Book button **locks after a successful booking** (was re-clickable →
      could book a second truck).
    - **"Pending pickup" column added to the Tracking board** — booked but not
      yet scanned; sorted soonest-pickup-first; flips to "Needs attention"
      with a "Pickup date passed — never scanned" badge if the truck never came.
    - FedEx status code `PU` (picked up) now maps to in_transit so collected
      packages leave "Pending pickup" on the next poll.
    Remaining: UPS (Cyrex) pickups are still manual — dialog calls them out.

---

## Cross-cutting themes (for prioritization)
- **Grouping by date** underpins: Nadia's email (#12), manage-labs view (#18),
  bulk actions (#19), merge-by-date (#17).
- **DOB** underpins: edit-on-card (#23), Zenoti capture gap (#5), req forms (#7).
- **Email automation confidence** (#11–15) is its own verification pass.
- **Records portal** (#22) is the biggest standalone feature.

> See also: `docs/PLAYBOOK.md`, `docs/E2E_TEST_RUNBOOK.md`, and the IV-charting
> work (memory `project_lab_tracker_iv_charting`).
