<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reuse before you rebuild

Before writing any new utility, parser, or transform, **read [docs/PLAYBOOK.md](docs/PLAYBOOK.md) and grep the codebase** for the concept. This repo has solved most of its problems once already — barcode normalization, lab-name matching, panel parsing, tracking auto-advance, the scrapers — and rebuilding them wastes a full test cycle. When you solve something non-obvious, add a one-line row to the PLAYBOOK so the next session finds it. The PLAYBOOK is the index; the linked code is the source of truth.
