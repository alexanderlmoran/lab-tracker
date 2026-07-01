# Lab Tracker

Human-gated middleware between **Zenoti** (appointments), the **lab portals**
(7 scrapers), and **PracticeBetter** (patient charts). A Zenoti lab appointment
becomes a tracker case → the result PDF is scraped when ready → a human approves →
it posts to the patient's PB chart. Reconcile and integrity passes keep it honest.

- **App:** Next.js 16 on Vercel — `centnerlabs.com`
- **Worker:** Fly app `lab-tracker-worker` (9 always-on/scale-to-zero process groups)
- **Data:** Supabase (Postgres + storage), Resend (email), Anthropic (PDF identity)

## Start here (docs)

Read these before writing code or debugging — most "new" problems here were solved once already:

1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the system map + the gotchas that cause re-investigation (Zenoti sync gates, the dark-mode `invert()` CSS trap, the `fly deploy` machine-stop, the PB IP block, fail-closed patient safety).
2. **[docs/INCIDENTS.md](docs/INCIDENTS.md)** — every past bug/gap + its guardrail. Check here before assuming a behavior is a new bug.
3. **[docs/DB_HARDENING.md](docs/DB_HARDENING.md)** — where patient-safety is code-only vs structural, and the prod-drift checks.
4. **[docs/PLAYBOOK.md](docs/PLAYBOOK.md)** — the reuse index (does this helper already exist?).

`AGENTS.md` (imported by `CLAUDE.md`) points agents at the same web.

## Dev

```bash
npm run dev          # Next.js app (root)
cd worker && npm run dev   # the automation worker
```

Deploy: Vercel auto-deploys the root on push. The worker ships with
`cd worker && fly deploy && bash scripts/start-all-machines.sh` — **the
`start-all-machines.sh` is not optional** (`fly deploy` leaves always-on machines
stopped; see ARCHITECTURE → Deploy / ops).
