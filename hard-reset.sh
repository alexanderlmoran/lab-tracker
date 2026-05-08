#!/usr/bin/env bash
# Hard reset for Lab Tracker.
#
# Default (frontend reset):
#   - Kills any running Next.js dev / build processes
#   - Removes .next, .turbo, node_modules/.cache
#   - Wipes node_modules and reinstalls from package-lock.json
#
# With --db:
#   - Additionally TRUNCATEs lab_cases, lab_events, email_logs in Supabase.
#     Patient cases, audit log, and email-send log are erased — irreversible.
#     Schema, enums, and Supabase Auth users are NOT touched.
#   - Prompts for explicit confirmation before running the TRUNCATE.
#
# Usage:
#   ./hard-reset.sh           # frontend only
#   ./hard-reset.sh --db      # frontend + wipe data tables
#   ./hard-reset.sh --db -y   # skip the confirmation prompt (CI / scripted)

set -euo pipefail

cd "$(dirname "$0")"

DO_DB=false
ASSUME_YES=false

for arg in "$@"; do
  case "$arg" in
    --db|--all)   DO_DB=true ;;
    -y|--yes)     ASSUME_YES=true ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed -n 's|^# \{0,1\}||p' | sed '$d'
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      echo "Run with -h for usage." >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

# ── 1. Kill dev / build processes ────────────────────────────────────
step "Killing Next dev / build processes"
killed=0
for pattern in "next-server" "next dev" "next start" "next build"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -9 -f "$pattern" 2>/dev/null || true
    killed=$((killed + 1))
  fi
done
if [ "$killed" -gt 0 ]; then
  sleep 1
  ok "Stopped $killed running process(es)"
else
  ok "No dev / build processes were running"
fi

# ── 2. Clear caches ──────────────────────────────────────────────────
step "Clearing build caches"
rm -rf .next .turbo node_modules/.cache 2>/dev/null || true
ok "Removed .next, .turbo, node_modules/.cache"

# ── 3. Reinstall dependencies ────────────────────────────────────────
step "Wiping node_modules and reinstalling"
rm -rf node_modules
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
ok "Dependencies reinstalled"

# ── 4. Optional: TRUNCATE data tables ────────────────────────────────
if $DO_DB; then
  step "Resetting Supabase data tables"

  if [ ! -f .env.local ]; then
    echo "ERROR: .env.local not found; cannot reset DB" >&2
    exit 1
  fi

  if ! $ASSUME_YES; then
    cat <<EOF

  This will TRUNCATE the following tables in your Supabase project
  ($(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)):
    - lab_cases
    - lab_events
    - email_logs

  Schema, enums, and Auth users will NOT be touched.
  This action is irreversible.

EOF
    read -rp "  Type 'RESET' to confirm: " confirm
    if [ "$confirm" != "RESET" ]; then
      warn "Aborted — DB not reset"
      exit 0
    fi
  fi

  node --env-file=.env.local -e '
    const { createClient } = require("@supabase/supabase-js");
    const c = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
    );
    (async () => {
      // Order matters only without ON DELETE CASCADE; ours cascades from
      // lab_cases, but we issue per-table deletes for clarity / explicit failure.
      for (const table of ["email_logs", "lab_events", "lab_cases"]) {
        const r = await c.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
        if (r.error) {
          console.error(`FAILED on ${table}:`, r.error.message);
          process.exit(1);
        }
        console.log(`  cleared ${table}`);
      }
    })();
  '
  ok "Data tables truncated"
fi

step "Done"
echo
echo "  Next steps:"
echo "    npm run dev      # start Next.js"
echo
