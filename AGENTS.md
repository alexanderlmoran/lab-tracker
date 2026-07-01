<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# How this system is wired — read before debugging

Before tracing a subsystem to answer "why didn't X happen?", read the doc web in this order:
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the master system map. Front-loads the *gotchas that cause re-investigation* (Zenoti sync gates, the dark-mode CSS `invert()` trap, the `fly deploy` machine-stop, the PB IP block, fail-closed patient safety) and maps each subsystem to its owning files/vars.
- **[docs/INCIDENTS.md](docs/INCIDENTS.md)** — every past bug/gap since go-live, its root cause, and the guardrail that now prevents it (or "still a risk"). Read before assuming a behavior is a new bug — it may be a known one. **Add a row the day any new incident happens.**
- **[docs/DB_HARDENING.md](docs/DB_HARDENING.md)** — where patient-safety is code-only vs structural, the constraints that would make regressions impossible, and the **prod-drift checks** (a hand-applied migration that never hit prod can silently disable a guard).

When you spend >2 minutes learning how something works, add it to ARCHITECTURE so the next session doesn't repeat it. We do not repeat the same error twice.

# Reuse before you rebuild

Before writing any new utility, parser, or transform, **read [docs/PLAYBOOK.md](docs/PLAYBOOK.md) and grep the codebase** for the concept. This repo has solved most of its problems once already — barcode normalization, lab-name matching, panel parsing, tracking auto-advance, the scrapers — and rebuilding them wastes a full test cycle. When you solve something non-obvious, add a one-line row to the PLAYBOOK so the next session finds it. The PLAYBOOK is the index; the linked code is the source of truth.
