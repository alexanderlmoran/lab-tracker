#!/usr/bin/env bash
# Run after EVERY `fly deploy`. A deploy can leave always-on worker process
# machines (zenoti/scrape/tracking/pbdrain/reconcile/ivpost/gmailsync) STOPPED —
# Fly doesn't auto-restart non-http process groups — which silently kills the
# whole pipeline until someone notices a missing result (the "Synced 8d ago"
# outage). This starts every machine so no loop is left down.
#
# The heartbeat watchdog (/api/cron/heartbeat-watch) is the backstop that emails
# if one still slips through, but running this turns the footgun off at the source.
#
# Usage:  cd worker && fly deploy && bash scripts/start-all-machines.sh
set -euo pipefail
APP="${1:-lab-tracker-worker}"
# The binary is `fly` locally but `flyctl` on the GitHub Action runner
# (superfly/flyctl-actions installs flyctl, no `fly` alias) — detect either so
# this works in both. Both exist on the dev Mac; CI has only flyctl.
FLY="$(command -v flyctl || command -v fly || true)"
if [ -z "$FLY" ]; then echo "flyctl/fly not on PATH"; exit 1; fi
# NOTE: ${APP} braces + ASCII "..." — macOS's bash 3.2 reads a bare $VAR followed
# by a multibyte char (…) as part of the var name → "unbound variable" under set -u.
echo "Starting all machines for ${APP}..."
ids="$("$FLY" machine list -a "$APP" --json | python3 -c 'import sys,json; [print(m["id"]) for m in json.load(sys.stdin)]')"
if [ -z "$ids" ]; then echo "No machines found for $APP."; exit 0; fi
for id in $ids; do
  echo "  start $id"
  "$FLY" machine start "$id" -a "$APP" || true
done
echo "Done. Verify: fly status -a $APP"
