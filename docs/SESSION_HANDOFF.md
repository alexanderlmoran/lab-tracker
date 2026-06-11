# Lab Tracker — Session Handoff (2026-06-10)

Everything from the long 2026-06-09→10 session, written so the chat can be
`/clear`ed and picked up cold. Pairs with `docs/TRACKER_BACKLOG.md` (status
block) and `docs/PLAYBOOK.md` (reuse index).

`main` HEAD = **`361468b`**, all pushed to `origin/main`
(`alexanderlmoran/lab-tracker`). Repo: Next.js single-deploy on **Vercel**;
**worker** (Fastify scrapers + Zenoti loops) on **Fly**.

---

## TL;DR — what's live now
- Pickup/Ready-to-Ship lane, "New"→"TO DO", duplicate cleanup tool, the whole
  2026-06-09 parallel-workflow backlog sweep, manage-labs, card layout, merge
  views, **drag-cards-to-columns**, **per-column sort**, **manual PDF upload**,
  the pull+stage flow, and a thorough **lab-pull diagnostic**.
- **App changes (most things) auto-deploy on Vercel.** A few **worker** changes
  need a **`fly deploy`** (see "Deploy TODO").
- **Uncommitted IV-charting WIP is still in the working tree** (protected all
  session, never committed — see bottom).

---

## Shipped this session (newest first)

**Lab-pull system (the last big push):**
- `361468b` Auto-pull **accession-less Vibrant** cases (name+DOB, single-order-safe). ⚠ worker half needs `fly deploy`.
- `1f72bcd` **Manual PDF upload** on cards (`uploadResultPdf` + `ManualUploadButton`) — universal fallback for un-pullable results (no-scraper labs, EBOO, sessions down). Stages exactly like a scraped result → Pending Upload → Approve → PB.
- `f83847e` **Per-column sort** ⇅ (Name A–Z / Date / Lab type / Type+date), independent per lane.
- `acc868b` No-scraper labs banner says **"post manually"** instead of a misleading "search the portal".
- `9599fde` **Step 10 in right column**; **click-outside closes the card**; **drag cards onto columns** to move (applies the column's step, archive for Completed; confirm-gated; derived lanes no-op).
- `64f419f` Ready-to-Ship + **"10. Completed" render as real checkbox steps**; staging corrects a wrong accession (manual-pull path only).
- `577ae31` **Poll early** for results (from delivery / collection+2d, not the over-long predicted window) — fixes the "in 60d / never auto-pulled" case; **search-PDF button on Sample Sent** too; clearer stage rows.
- `6c7d3f9` **"Search for lab to post" now PULLS + STAGES** the PDF (worker `/probe?stageCaseId` → `postResultReady`), not just a ready/not-ready check. ⚠ worker change (already fly-deployed once this session).

**Steps / columns / wording:**
- `e5e005c` Step labels = their **board column name** (+ Nadia on step 5, Allison on step 9, in parens).
- `50d1139` Merge toggle "Dupes" → **"By accession"** (matches By patient / By date).
- `6e4bb58` Column label **"TODO" → "TO DO"** (by-lab + by-patient).
- `a765093` Staged PDF shows in the OPEN card (no exit/reopen); **badges trimmed by column** (ROF lanes = email only; Protocol received + Completed = none); **tracking meta hidden from Complete Uploaded onward**; **merge By patient / By date** within each column.

**Pickup + Ready-to-Ship (start of session):**
- `f83f39b` `02b0a24` `60a828e` Ready-to-Ship lane, pickup books only ready cards, step ladder = columns, "New"→TODO, tracking-entry decoupled from step 1.

**Duplicate cleanup + Zenoti prevention:**
- `971151d` `19b1902` `888605e` **Settings → Duplicates** tool (`findDuplicateGroups`/`resolveDuplicates`, `DuplicatesPanel.tsx`): groups by effective label (NOT raw lab_name/lab_panel — that lumped Vibrant Zoomer sub-panels), keeps most-progressed, soft-deletes extras on click. Verified live (21 real groups; Alex removed them). Zenoti route re-points a re-created appointment instead of inserting a dup. Same-accession orders auto-collapse on the board by default.

**The 2026-06-09 parallel-workflow sweep (10 worktree agents → cherry-picked):**
- `c741bfb` card chips wrap below text (10-col fit) + dedupe merged tracking #s
- `7b53f59` hide derived lanes from Move-to menu; stage rows as status
- `a72dfda` Manage-labs Save no longer auto-ticks Sample sent
- `42375e5` Records portal phase 1 (`/labs/records`)
- `367b8ea` Access partials staged re-checks (day 2 / 4-7 / 14)
- `4c260a4` group a patient's labs by date + merge patients/by-date (#16/#17)
- `b1e6534` Nadia group-outstanding email + inbox notifications (#12/#15)
- `7ac9d5b` Zenoti delete sync + merge move-together & ghost (#1/#3/#4)
- `fd81090` DOB edit-on-card → saves to patient (#23); Zenoti DOB gap TODO (#5)
- `a6bee6e` Req form pulls entered order# + calibrator in Settings (#7)
- `136e4ce` per-card manual probe (#6) + complete-upload notification (#21)
- `632efc2` Manage-labs date filter + bulk sample-sent (#18/#19)
- `7c1dee3` Humanize activity log + step wording (#9/#10)

---

## Deploy TODO (not auto-handled by Vercel)
The **worker** code lives in `worker/` and runs on **Fly** — it does NOT deploy
with Vercel. These need a **`fly deploy`** then **`fly machine start <id>`** for
the always-on zenoti machine (the deploy-stops-it gotcha):
1. **`worker/src/scrapers/vibrant.ts`** — single-order safety guard + accession-less name match (commit `361468b`).
2. **`worker/scripts/zenoti-auto-loop.ts`** — Zenoti delete reconcile fix (commit `7ac9d5b`). Needs a live deletion to confirm.
3. (The `/probe?stageCaseId` worker change `6c7d3f9` was already fly-deployed mid-session.)

Everything else (`open-cases`, `result-ready`, all `src/app/**`) is the Next app → Vercel.

---

## Local dev state
- A **local worker is running on port 8080** (started this session via
  `cd worker && tsx -e "import('./src/lib/load-env.ts').then(m=>{m.loadEnvLocal();return import('./src/server.ts')})"`).
  It's running the **scraper code as of session start** — **restart it** to pick
  up the `vibrant.ts` change. Normal way: `cd worker && npm run dev`.
- **`.env.local` has NO portal session secrets** (`*_SESSION_*` live only as Fly
  secrets). So **Genova / DoctorsData fail locally** (session/login) — they may
  work on prod. **Access / Cyrex / Spectracell / Vibrant** are creds-only → work
  locally.

---

## Lab-pull diagnostic (ran a live pass over 45 Sample-Sent cases)
Root causes found — **it's per-portal, not one bug**:
- **8 pullable now** (Access / Cyrex / Spectracell).
- **No scraper at all (manual only):** MembersPanel, Custom, Kennedy Krieger,
  Mitoswab, Peptides, Viome, RGCC, L2Bio, etc. → now handled by **manual upload**.
- **Genova / DoctorsData:** session/login failures (local has no sessions;
  Genova MFA-expires on prod too). The UI used to mask these as "not ready."
- **Vibrant:** the diagnostic dry-run used `probeByName`, which is **complete-only
  and never downloads** — so it *understated* what the real pull (the `run()`
  path, which downloads partials) can get. Live truth:
  - **Vinay Mittal** — acc `2606086632` IS his order (accession was correct, not
    wrong); 1 finished section (VA) + 1 analyzing (NEUZP) = **PARTIAL** → pullable.
  - **Funnah Pasha, Leo Stimler** — genuinely **NOT READY** (sections still processing). System is correct.
  - **Michelle Schuemister** — **NO patient match** by name in Vibrant → the
    card's name ≠ the portal's spelling. **Data fix: correct her name** (or use manual upload). Not a scraper bug.
- **EBOO Waste** — Vibrant finds the order but the EBOO report isn't a downloadable
  PDF → manual upload.

---

## What's LEFT (open items)
**Not built yet:**
- **#8** rename "Partial Uploaded" col → "Pending Upload" + search inside it —
  **blocked on a decision** (you already have *both* a "Pending Upload" and a
  "Partial Uploaded" lane; tell me what those two should be).
- **#5** auto-capture DOB from Zenoti (needs a guest-detail endpoint / HAR
  capture). Manual DOB edit (#23) is the interim and works.
- **#22 phase 2** historical backfill (Jun 2025→ pre-tracker orders). Phase 1
  (`/labs/records`) is live; phase 2 needs a source decision.

**Needs a decision:**
- **#11** auto-send patient *tracker* emails on step moves — `auto_send_emails`
  defaults true on every historical case, so flipping it would blast old
  patients. Decide the rule first.
- **#13 / #14** Kennedy→BodyBio + labs@centnerhb.com aggressiveness; need live
  inbox proof.
- **Records portal** role-gating (`/labs/records` is visible to all roles).
- The "two big fixes" both shipped — but a 3rd, **portal session-health surfacing**
  (Genova/DoctorsData "re-login needed" instead of "not ready"), was proposed and
  not built. Worth doing.

**Built — needs live verification:**
- #1 Zenoti delete (watch a real deletion via the Fly zenoti loop, after `fly deploy`).
- #6/#21, #7, #12/#15, #20 — live inbox/portal pass.

**Operational (your hands):**
- The Vibrant single-order guard means a **multi-order, accession-less** Vibrant
  patient now says "not found" instead of guessing — set the accession or use
  manual upload for those.
- Correct **Michelle Schuemister's** name to match Vibrant.

---

## Gotchas learned this session (so they don't bite again)
- **Worker ≠ app.** `worker/**` deploys to **Fly** (`fly deploy` + `fly machine
  start`), not Vercel. The Zenoti route + open-cases + result-ready are in the app.
- **`git stash pop` leaves restored files STAGED** → a plain `git commit`
  sweeps them. Always **`git commit <explicit paths>`**.
- **Group duplicates by `labelForCase` (effective label), NOT raw
  `lab_name`+`lab_panel`** — Vibrant multi-panels share lab_name="Vibrant",
  lab_panel=null with the panel in `zenoti_service_name`; raw grouping deletes
  real panels.
- **Vibrant `probeByName` is complete-only and never downloads** (drip-safe
  auto-post). The real pull is the `run()` path (downloads partials).
- **Heredoc with `<<'EOF'` still backslash-escaped `!`** in this shell → wrote
  `\!` into TS. Use the Write tool for code, not heredocs.
- **`.env.local` has no portal sessions locally**; they're Fly secrets.

---

## Uncommitted IV-charting WIP (DO NOT lose)
Still in the working tree, never committed this session (protected through every
merge/stash):
- `M src/app/labs/HudPulse.tsx` (the `/labs/iv` nav link)
- `D src/pdfjs-legacy.d.ts`
- `M worker/scripts/zenoti-sync.ts`, `worker/src/uploaders/practicebetter.ts`,
  `worker/src/zenoti/fetch-browser.ts`, `worker/src/zenoti/types.ts`
- Plus untracked IV files: `src/app/labs/iv/`, `src/app/api/worker/iv-*`,
  `worker/src/iv/`, `worker/scripts/*iv*`, `supabase/migrations/20260609_iv_*.sql`, etc.

See memory `project_lab_tracker_iv_charting` for the IV build status.
