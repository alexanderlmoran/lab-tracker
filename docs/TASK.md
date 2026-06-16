# IV Charting — Tasks

Active + deferred work for the IV charting feature. See also
[project memory] and `docs/TRACKER_BACKLOG.md`.

## 2026-06-16 — PC infusion # ledger (built, NOT yet applied/deployed)

Fixed the PC numbering mismatch (Leila's note posted without "#30"). Root cause:
the number was re-derived from PB note titles by a separate enrich pass that the
auto-post drain raced (drain posted first → bare "Phosphatidylcholine Infusion").

Built a **local ledger** (`iv_infusion_series`) we own: seeded ONCE per patient
from PB, then the number is assigned atomically at post time and never re-read
from PB. See the PLAYBOOK row "PC infusion #".

**To go live (in order):**
1. Apply `supabase/migrations/20260616_iv_infusion_series.sql` (Supabase SQL editor).
2. Bootstrap: `cd worker && IV_SEED_COMMIT=1 npx tsx scripts/iv-enrich-pc-history.ts`
   (dry-run first without the flag). Run from a clean IP (PB egress).
3. Deploy app (Vercel) + worker (`cd worker && fly deploy`; then `fly machine start`
   the stopped machines). Health check: `npx tsx scripts/iv-verify-ledger.ts`.

**Hardened after code review** (6 findings fixed): staff # overrides now sync the
ledger; ambiguous PB matches HOLD instead of auto-posting "#1"; the form peek is a
placeholder, not a saved value (no duplicate #s across two pending sessions); the
mint rolls back the ledger if the session write fails (no burned #s); the staff-
confirmed path also holds when unnumbered; the seed GET only scans unposted PC
sessions (no starvation at scale); PB-read seed logic centralized in
`worker/src/iv/pc-series.ts`.

**Remaining note:** `iv-verify-ledger.ts` lists already-posted PC notes with no #
(pre-fix mismatches, incl. Leila's) — those are a manual PB re-title.

## Deferred (by decision)

- **Lot # / stock / order logging** — _deferred 2026-06-11 (Alex)._
  Removed the Lot # / Exp inputs from the charting form for now ("delete stock #
  until I can log orders and lot and stocks another day"). The data model still
  carries them: `ComponentRow.lot`/`.exp` (actions.ts) exist and
  `buildComponents` (build-note-content.ts) still writes the Lot cell if a lot is
  present. **To re-enable:** (1) build an orders → lot → stock/inventory logging
  system; (2) restore the Lot/Exp inputs in `IvChartForm.tsx`; (3) let the form
  pick a lot from current stock so it flows into the note + decrements inventory.

## Open

- **Add-on auto-merge** — add-ons are currently *skipped* from standalone posting
  (held: "include on the base IV note"); the nurse adds their components to the
  base session's chart by hand. _Open:_ auto-merge an add-on's components into the
  visit's base note (needs reliable base↔add-on linkage via Zenoti guest+visit).

- **Held-review patient search** — "Confirm & post" vouches for the matcher's best
  candidate. For holds with *no* candidate (patient not in PB / not seeded), add a
  patient search so staff can pick the record. (Tie/ambiguous holds already warn.)

- **Quick-entry card (board)** — shipped a "⚡ Quick fill (normal)" button on the
  per-session form. _Open:_ optionally an inline quick-entry card on the board to
  chart + post without opening the detail page.

- **Fly deploy (last mile)** — scheduling is now WIRED in code; just needs a
  deploy:
  - `ivpost` Fly process (`worker/fly.toml`) runs `iv-autopost-loop.ts` under the
    PB egress: drains the queue every ~5 min (staff posts) **and runs the sweep
    daily at 5pm ET** (`IV_SWEEP_HOUR_ET`, default 17) so notes never go missing.
  - IV board sync is folded into `zenoti-auto-loop.ts` (the `zenoti` process) —
    it reuses the loop's headless Zenoti login, so **no separate capture is
    needed**; lab + IV sync share one session.
  - **To go live:** `cd worker && fly deploy` — FOOTGUN: leaves the always-on
    zenoti machine stopped → `fly machine start <id>` after (see zenoti deploy
    gotcha). The egress reuses the existing `TS_AUTHKEY` + `TS_EXIT_NODE` secrets
    (same as pbdrain/reconcile). First live 5pm sweep auto-posts the day's
    unposted IVs — confirm that's intended before/at first run.
  - Note: `PB_TEST_PATIENT_ID` is blank in `.env.local` (scripts use the Leila
    fallback `641868664a3099220158325b`); set it to be safe.

## Done (2026-06-11)

- Post path verified end-to-end on the test patient (10/10 read-back checks).
- 3 clinical-content bugs fixed (dropped sections, lot leak, lost doses).
- Patient matcher verified on real PB data (100, autoPostable).
- Full worker loop verified (queue → claim → match≥95 → post → result).
- App pushed + Vercel prod deploy live.
- Delete API (`deleteSessionNote`) + cleaned up all test notes.
- Every template builds a complete note (15/15); `template_hint` matching
  normalized (apostrophe/whitespace/case-robust).
- **Post-regardless-flag:** posting works with an empty/partial chart; the
  session is flagged "incomplete" on the board + form, and the PB note `summary`
  carries a "⚠ INCOMPLETE — still to chart: …" marker.
- **The 5 review gaps (all verified live):**
  1. **Auto-post sweep** — `/api/worker/iv-post/sweep` enqueues every occurred,
     un-posted IV (window-bounded, `dryRun`); drain worker posts ≥95 matches
     flagged-incomplete, holds the rest. Notes never go missing.
  2. **IM Medication / IM Shot** — form fields + note mapping (form-driven IM rows
     + yes/no). Verified persisting.
  3. **Add-on skip** — add-ons held ("include on the base IV note"), no stray note.
  4. **Base-template fallback** — `__base_iv__` (→ Immune Boost ref) covers
     custom/chelation/unmatched so they post instead of holding.
  5. **Held-review panel** on `/labs/iv` — Re-try, Open, "Confirm & post" (force-
     post to the vouched patient); ambiguous/tie holds flagged for manual check.
