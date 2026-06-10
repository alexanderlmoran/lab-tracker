# Lab Tracker — Backlog & Notes

Raw brain-dump from Alex (captured 2026-06-09) for a clean restart. Grouped by
theme; original intent preserved. Lines marked _(ptr: …)_ are pointers I added
to where the relevant code likely lives — verify before trusting.

---

## ✅ Build status — 2026-06-09 (parallel-workflow sweep + pickup work)

Implemented via 10 worktree-isolated agents, cherry-picked onto `main` (tsc +
full build green on the combined tree). Commits listed per item.

**Done (code complete, no decision needed):**
- #2, #24 — Ready-to-Ship lane, New→TODO, pickup books only ready cards, +
  card step ladder (Ready-to-ship / Completed stages). _(60a828e, 02b0a24, f83f39b)_
- #9 — step labels speak the column vocabulary; #10 — activity log humanized +
  major/minor toggle (`humanize-event.ts`). _(7c1dee3)_
- #18, #19 — Manage-labs date-group filter + bulk "Sample sent (no emails)" /
  Save-all (3-button footer). _(632efc2)_
- #6 — per-card "Search for lab to post" probe on stuck Pending-Upload;
  #21 — complete-upload staff notification. _(136e4ce)_ ⚠ live-verify the email/probe.
- #7 — req form pulls the entered order# (`lab_external_ref`) for all modes;
  calibrator now in Settings → Req forms. _(a6bee6e)_ ⚠ live-verify in app.
- #23 — edit DOB on the card → saves to the patient (propagates to all cases +
  seed). #5 — Zenoti exposes no DOB; precise TODO left for a guest-detail lookup. _(fd81090)_
- #3, #4 — manual step toggles move same-order siblings together; merge-dupes
  collapses cross-column (no ghost). #1 — Zenoti delete reconcile fixed in the
  PROD loop (`zenoti-auto-loop.ts`). _(7ac9d5b)_ ⚠ #1 needs live Zenoti verify.
- #12 — Nadia email reflects the GROUP's outstanding labs; #15 — inbox unread
  badge + main-board new-email banner. _(b1e6534)_ ⚠ live inbox proof.
- #16, #17 — group a patient's labs by collection date; Merge patients /
  Merge by date in the by-patient action bar. _(4c260a4)_
- #20 — Access partials: staged re-checks (day 2 / 4-7 / 14) gate the scrape feed. _(367b8ea)_ ⚠ live-verify.
- #22 — Records portal **phase 1**: `/labs/records` over existing cases. _(42375e5)_

**Needs an owner decision (flagged, not guessed):**
- #11 — auto-send patient *tracker* emails on step moves: still button-gated by
  design (the `auto_send_emails` flag defaults true on all historical cases, so
  flipping it would blast old patients). Decide before wiring.
- #13, #14 — Kennedy→BodyBio + labs@centnerhb.com: code wired; need live inbox proof.
- #22 phase 2 — historical backfill (pre-tracker PB/Zenoti orders, Jun 2025→): source TBD.
- Records role-gating (currently visible to all roles).

---

## 🐞 Bugs

1. **Zenoti deletion not syncing.** When an appointment is deleted in Zenoti, the
   tracker case is NOT deleted. _(ptr: deletion-reconciliation already exists in
   `src/app/api/worker/cases/route.ts` via the `syncedDates` census + `RECONCILE_GRACE_MS`;
   verify the Zenoti sync is actually POSTing a COMPLETE per-day census, and that
   the zenoti machine/loop is running — see `worker/scripts/zenoti-sync.ts`.)_

2. ~~**Tracking# auto-completes "Sample sent" (should be MANUAL).**~~ ✅ **FIXED
   2026-06-09** (same change as #24). Entering a tracking # now moves the card to
   the new **Ready to ship** lane instead of auto-ticking step 1. Step 1 ticks
   only on a FedEx scan (refresh-core PU/in_transit/delivered) or a manual toggle.
   Decoupled in `updateLabCase` + `attachTrackingFromScan`; `bulkUpdatePatientCases`
   never ticked it. The cron poller selects by tracking # regardless of step 1, so
   ready-to-ship cards still auto-advance on pickup.

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

24. ~~**"Schedule pickup (109)/(20)" — wrong cards counted; need a "Ready to
    ship" column.**~~ ✅ **FIXED 2026-06-09.** Root cause: the dialog counted
    every card with a tracking # that wasn't booked through the app — including
    already-shipped/delivered cards (FedEx purges history → status "unknown")
    and kit-out tracking #s — and pre-selected them all. The real fix was a new
    workflow lane:
    - **Renamed "New" column → "TODO"** (by-lab `untouched` + by-patient `p_new`).
    - **New "Ready to Ship" column** between TODO and Sample Sent: a card lands
      here when it has a tracking # but step 1 isn't ticked
      (`isReadyToShip = tracking_number && !step1_sample_sent`,
      `src/lib/labs/pickup.ts`, shared by `getColumnFor`). Orange lane color.
    - **Decoupled tracking-entry from step 1** (backlog #2) so cards actually
      rest in Ready-to-ship instead of skipping to Sample Sent. The FedEx
      pickup/in-transit scan ticks step 1 (refresh-core); the cron poller selects
      by tracking # regardless of step 1, so the loop still closes.
    - **Pickup candidates = the Ready-to-ship lane** (`awaitingPickup`). Already-
      sent cards (step 1 already ticked) no longer appear. NOTE: right after this
      ships the dialog shows ~0 candidates because every existing card was
      auto-ticked to step 1 under the old behavior — the lane fills from NEW
      draws going forward.
    - Confirmed one "Book pickup" click = **one** FedEx API call
      (`POST /pickup/v1/pickups`, `packageCount` = selected count); stamps only
      checked cards; nothing books pickups automatically; button locks after success.
    - Tracking board: **"Pending pickup" column** (booked, not yet scanned) +
      "Pickup date passed — never scanned" attention badge. FedEx `PU` now maps
      to in_transit so collected packages clear the lane on the next poll.
    Remaining: UPS (Cyrex) pickups still manual — dialog calls them out.

---

## Cross-cutting themes (for prioritization)
- **Grouping by date** underpins: Nadia's email (#12), manage-labs view (#18),
  bulk actions (#19), merge-by-date (#17).
- **DOB** underpins: edit-on-card (#23), Zenoti capture gap (#5), req forms (#7).
- **Email automation confidence** (#11–15) is its own verification pass.
- **Records portal** (#22) is the biggest standalone feature.

> See also: `docs/PLAYBOOK.md`, `docs/E2E_TEST_RUNBOOK.md`, and the IV-charting
> work (memory `project_lab_tracker_iv_charting`).
