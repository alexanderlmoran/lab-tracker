FROM mcr.microsoft.com/playwright:v1.60.0-jammy
# Base image version MUST match the playwright npm version (package.json pins it
# exactly). Bump one, bump both — a mismatch = "Executable doesn't exist".

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Recurring-job scripts (run via tsx by Fly scheduled machines, e.g. the PB
# drainer). Not part of the HTTP server build, but bundled so a scheduled
# machine can `npx tsx scripts/<job>.ts --once`.
COPY scripts ./scripts

# Tailscale binaries — the pbdrain + reconcile process groups route PracticeBetter
# traffic through a residential exit node (PB blocks datacenter IPs). We run
# tailscaled in userspace mode via scripts/pb-egress-entrypoint.sh; no systemd.
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale
RUN mkdir -p /var/run/tailscale /var/lib/tailscale \
 && chmod +x ./scripts/pb-egress-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
