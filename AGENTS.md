<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# How this system is wired — read before debugging

Before tracing a subsystem to answer "why didn't X happen?", **read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the master system map. It front-loads the *gotchas that cause re-investigation* (the Zenoti sync gates, the dark-mode CSS `invert()` trap, the `fly deploy` machine-stop, the PB IP block, fail-closed patient safety) and maps each subsystem to its owning files/vars. When you spend >2 minutes learning how something works, add it there so the next session doesn't repeat it.

# Reuse before you rebuild

Before writing any new utility, parser, or transform, **read [docs/PLAYBOOK.md](docs/PLAYBOOK.md) and grep the codebase** for the concept. This repo has solved most of its problems once already — barcode normalization, lab-name matching, panel parsing, tracking auto-advance, the scrapers — and rebuilding them wastes a full test cycle. When you solve something non-obvious, add a one-line row to the PLAYBOOK so the next session finds it. The PLAYBOOK is the index; the linked code is the source of truth.
