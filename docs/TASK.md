# IV Charting — Tasks

Active + deferred work for the IV charting feature. See also
[project memory] and `docs/TRACKER_BACKLOG.md`.

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

- **Quick-entry card (board)** — shipped a "⚡ Quick fill (normal)" button on the
  per-session form (stamps the normal-visit boilerplate). _Open:_ optionally add
  an inline quick-entry card on the `/labs/iv` board so a nurse can chart all
  variables + post without opening the detail page. Confirm scope with Alex.

- **Fly worker scheduling (deploy last mile)** — the app is live on Vercel, but
  the worker automation isn't scheduled in prod. Needs:
  1. loop wrappers — `iv-post-worker.ts` (≤50 then exits) + `zenoti-iv-sync.ts`
     are one-shot; add `--loop` modes or loop scripts;
  2. `iv-post` MUST run via `bash scripts/pb-egress-entrypoint.sh` (Tailscale
     exit node) — it touches PB, which blocks Fly datacenter IPs (err 8000);
  3. two `[processes]` entries in `worker/fly.toml`;
  4. `fly deploy` (footgun: leaves the zenoti machine stopped → `fly machine
     start`);
  5. **fresh Zenoti capture** for `ZENOTI_SESSION_B64` (human-only login via
     `/lab-portal-capture`) so the prod board auto-populates.

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
