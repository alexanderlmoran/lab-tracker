#!/usr/bin/env bash
# PB egress wrapper — brings up Tailscale in USERSPACE mode and routes ONLY
# PracticeBetter traffic through a residential exit node, then runs the given
# command (pbdrain / reconcile). PB blocks datacenter IPs (error 8000) — Fly,
# Vercel, AND every commercial proxy we tried — so PB calls must exit through a
# clean machine the clinic already uses (the exit node). Everything else in the
# process (Access scraping, etc.) keeps using Fly's normal egress, because
# userspace mode adds NO default route — only traffic sent to the local proxy
# (PB_PROXY_URL=http://localhost:1055) goes through the exit node.
#
# Validated 2026-06-05 with this exact flag set: PB login succeeded through the
# clinic exit node (egress 208.88.124.50). See project memory pb-ip-block.
#
# Required env (set as Fly secrets):
#   TS_AUTHKEY   reusable+ephemeral tailnet auth key (tskey-auth-...)
#   TS_EXIT_NODE exit-node tailnet IP or MagicDNS name (e.g. 100.122.3.35 / alex-labtop)
# Optional:
#   TS_HOSTNAME  node name shown in the tailnet (default: fly-pb-worker)
set -euo pipefail

if [ -z "${TS_AUTHKEY:-}" ] || [ -z "${TS_EXIT_NODE:-}" ]; then
  echo "pb-egress: TS_AUTHKEY / TS_EXIT_NODE not set — refusing to start" \
       "(PB calls would hit the datacenter IP block)." >&2
  exit 1
fi

mkdir -p /var/lib/tailscale /var/run/tailscale

tailscaled \
  --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --outbound-http-proxy-listen=localhost:1055 \
  --socks5-server=localhost:1056 &
TSD_PID=$!

# tailscaled takes a moment to open its socket; `tailscale up` fails fast until
# then, so retry. (This sleep runs inside the Fly container, not the dev host.)
up_ok=""
for _ in $(seq 1 60); do
  if tailscale up \
      --authkey="${TS_AUTHKEY}" \
      --hostname="${TS_HOSTNAME:-fly-pb-worker}" \
      --exit-node="${TS_EXIT_NODE}" \
      --exit-node-allow-lan-access \
      --accept-dns=false; then
    up_ok=1; break
  fi
  sleep 2
done
if [ -z "$up_ok" ]; then
  echo "pb-egress: tailscale up failed after retries (exit node ${TS_EXIT_NODE} reachable?)" >&2
  kill "$TSD_PID" 2>/dev/null || true
  exit 1
fi

echo "pb-egress: tailnet up; PracticeBetter traffic egresses via ${TS_EXIT_NODE}"
# Only PB-domain calls (pbRequest in practicebetter.ts) read this; S3 + scraping
# stay on direct Fly egress.
export PB_PROXY_URL="http://localhost:1055"

exec "$@"
