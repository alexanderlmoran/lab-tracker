# Backfill brain — runbook

Layer 2 of the smart lab tracker. Reconciles bulk-imported "stuck at step 1"
tracker rows against PracticeBetter's existing lab results, archives
duplicates, and silently advances cases that are already filed on PB.

Originally exercised end-to-end against **Leila Centner on 2026-05-27**:
18 collection_dates backfilled from the CSV → 7 duplicate rows archived →
5 high-confidence step5 advances. 23 cases remained for the manual sweep [D].

## Pipeline (in order)

```
[A] CSV → collection_date backfill        (fills the null collection_date column from Lab Shipping - Main.csv)
       ↓
[B] Tracker dedupe                         (archives true-duplicate rows from the bulk import)
       ↓
[C] Backfill advance — high confidence     (silent step5 flip for cases already on PB at confidence=high)
       ↓
[D] Manual sweep                           (everything left in medium/low/needs-review)
```

Each script is preview-by-default. Add `--apply` only after eyeballing the
report. `--patient=<name>` filters to one person (substring match on
patient_name); `--patient=all` runs org-wide.

## Prereqs

- `npm run dev` (or just `npm run dev:next`) must be running — the scripts hit
  `http://localhost:3000/api/worker/debug/cases`.
- `.env.local` must have `WORKER_SHARED_SECRET`, `TRACKER_BASE_URL`,
  `PB_USERNAME`, `PB_PASSWORD`.
- `Lab Shipping - Main.csv` must be at the repo root (used by [A] and to
  generate `panelHint` in [C]).

All commands run from `worker/`.

## [A] Backfill collection_date from CSV

```bash
# preview
npx tsx scripts/backfill-collection-dates-from-csv.ts                  # Leila only
npx tsx scripts/backfill-collection-dates-from-csv.ts --patient=all    # org-wide

# apply
npx tsx scripts/backfill-collection-dates-from-csv.ts --apply
npx tsx scripts/backfill-collection-dates-from-csv.ts --patient=all --apply
```

What it does:
- Joins tracker rows ↔ CSV by exact `tracking_number` (normalized upper-case,
  whitespace stripped).
- Writes `collection_date` from the CSV `Date` column.
- Write-once: the debug endpoint refuses if `collection_date` is already set,
  so this is safe to re-run.

Patient-name mismatch (tracker patient name not found on the CSV row) prints
a `⚠ name-mismatch` warning and **does not auto-apply** even in `--apply` mode.

Also reports:
- ambiguous tracking#s (CSV has the same number in multiple rows)
- duplicate tracker rows (same tracking# in `lab_cases` >1×) — these feed
  step [B]

## [B] Dedupe tracker rows

```bash
# preview
npx tsx scripts/dedupe-tracker-cases.ts                     # Leila only
npx tsx scripts/dedupe-tracker-cases.ts --patient=all       # org-wide

# apply
npx tsx scripts/dedupe-tracker-cases.ts --apply
npx tsx scripts/dedupe-tracker-cases.ts --patient=all --apply
```

True-duplicate definition (strict on purpose): `patient_name + lab_name +
tracking_number + collection_date` all match. Cases sharing only tracking#
are deliberately ignored — those are usually Zenoti-sync row + bulk-import
row pairs that need separate reconciliation.

Canonical row per group:
1. Row with `zenoti_appointment_id` set wins (auto-restored by Zenoti sync
   if archived, so always survive).
2. Otherwise earliest `created_at`.
3. Tiebreak by lexicographic `id`.

The losers get `action=archive` (sets `archived_at`); they are recoverable
via Bulk Recovery in the UI.

> Heads-up: ~hundreds of tracker rows from the 2026-05-08 bulk import
> are duplicated. Run `--patient=all --apply` once to clean org-wide.

## [C] Advance high-confidence cases to step 5

```bash
# preview
npx tsx scripts/backfill-advance-highs.ts                   # Leila only
npx tsx scripts/backfill-advance-highs.ts --patient=all     # org-wide

# apply
npx tsx scripts/backfill-advance-highs.ts --apply
```

What it does:
- Re-runs the classifier (`worker/src/backfill/engine.ts`) against every
  stuck row.
- For each decision with `action=already-on-pb` AND `confidence=high`,
  fires `PATCH ?action=advance-step5` on the debug endpoint.
- That endpoint sets `step5_complete_uploaded=true` via a direct DB update
  and **bypasses the email cascade** (Nadia "all received", Allison
  handoff, patient notifications). Logs a `step_toggled` event with
  `actor=admin:backfill-brain` for audit.

Confidence ladder (engine.ts):

| Match type                                          | Confidence |
|---|---|
| Accession # appears in PB labrequest name           | high       |
| Lab name substring match, ≤7 days off               | high       |
| Lab name substring match, ≤21 days off              | medium     |
| Panel hint substring match, ≤21 days off            | medium     |
| Name/hint substring match, 22–90 days off           | low        |
| Shared content word (token overlap), ≤90 days off   | low        |
| Beyond 90 days (no accession)                       | excluded   |

Only `high` auto-fires. Medium/low surface in the report for manual review.
Token overlap (a shared ≥4-char, non-stopword word between the tracker
name/hint and the PB title) is the fuzziest signal and is **always** capped
at `low` — it surfaces a candidate for a human glance but never auto-advances.

## [D] Manual sweep

After [A][B][C] complete, the leftovers in the preview reports break down as:

- **already-on-pb / medium**: matched a PB labrequest by name + close date.
  Almost always correct; just want a human glance.
- **already-on-pb / low**: matched by name with a 60-90d date gap, OR by
  panel hint only. Worth eyeballing.
- **scrape-needed**: PB doesn't have it but staff entered an accession #.
  Feed to the lab portal scraper.
- **needs-review**: PB doesn't have it and there's no accession to scrape.
  Either staff handled out-of-band or PB genuinely never received it
  (e.g. ReliGen).
- **leave**: collected within the 30d grace window — legitimately pending.

The Settings → Backfill UI (Phase 2) will surface these in a per-patient
table with approve/reject controls.

## Diagnostic / probe scripts

Use these when investigating mismatches before changing the engine:

- `worker/scripts/pb-dump-leila-labrequests.ts` — dumps every PB labrequest
  for Leila so you can confirm whether a missed match is "not in PB" vs
  "in PB but the engine didn't see it".
- `worker/scripts/backfill-leila-diagnose.ts` — verbose tracker + PB
  side-by-side for one patient.
- `worker/scripts/pb-probe-lab-resources.ts` — probes alternate PB endpoints
  (kept around as a reference for the next time we hunt for a non-labrequest
  resource type; current consensus: results _are_ all returned under
  `/api/consultant/labrequests`).

## Known engine gaps

- **Word-token matching** — ✅ shipped 2026-05-31. Substring matching was
  fragile when the hint and PB name shared words in a different order
  (tracker `panelHint="vaginal microbiome"` ⊄ PB `"Microbiome Labs (BIOMEFX)"`).
  The engine now also matches on a shared content word (≥4 chars, stopword-
  filtered) and surfaces those at `low` confidence. Covered by
  `worker/src/backfill/engine.test.ts`.
- **CSV Recipient Name as hint** — ⚠️ investigated and parked. The runbook
  originally assumed `Recipient Name` carries the lab destination (e.g.
  "microgendx") when `Carrier="Other"`. The actual `Lab Shipping - Main.csv`
  contradicts this: that column holds *people's names* (the shipper or an
  intermediary — "Matthew Whiteside", "MARINA CAMPBELL"), not labs. Feeding
  it as a `panelHint` would manufacture false token matches. Don't wire this
  in without first finding real rows where the column genuinely names a lab.
- **Dates embedded in PB titles**: PB labrequests often have the draw date
  in the title (e.g. "Access 03.26.26", "Glycanage 3.17.26") even when
  `dateOrdered` is the upload date weeks later. Parsing dates out of the
  title would lift several `low`-confidence matches to `high`.

## File map

```
worker/
├── src/backfill/engine.ts                              # classifier
├── src/uploaders/practicebetter.ts                     # PB session + listAllConsultantLabRequests
└── scripts/
    ├── backfill-collection-dates-from-csv.ts           # [A]
    ├── dedupe-tracker-cases.ts                         # [B]
    ├── backfill-advance-highs.ts                       # [C]
    ├── backfill-leila-preview.ts                       # classification report only
    ├── backfill-leila-diagnose.ts                      # patient probe
    ├── pb-dump-leila-labrequests.ts                    # dump PB side
    └── pb-probe-lab-resources.ts                       # alternate-endpoint scanner

src/app/api/worker/debug/cases/route.ts                 # PATCH actions: archive | soft-delete | hard-delete | set-collection-date | advance-step5
```
