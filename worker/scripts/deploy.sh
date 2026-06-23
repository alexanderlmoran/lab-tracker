#!/usr/bin/env bash
# One-shot worker deploy.
#
# `fly deploy` leaves the always-on machines (zenoti, tracking, scrape, pbdrain,
# reconcile, ivpost, gmailsync) STOPPED — a stop is not a crash, so nothing
# auto-restarts them, and sync silently dies until someone notices ("Synced 8d
# ago"). This wraps the deploy and the mandatory restart into one step so the
# restart can never be forgotten.
#
# Usage:  bash scripts/deploy.sh            # from worker/
#         bash worker/scripts/deploy.sh     # from repo root
# Extra args are forwarded to `fly deploy` (e.g. --ha=false, --build-arg ...).
set -euo pipefail

cd "$(dirname "$0")/.."   # -> worker/

echo "→ fly deploy"
fly deploy "$@"

echo "→ restarting always-on machines"
bash scripts/start-all-machines.sh

echo "✓ worker deployed and all machines running"
