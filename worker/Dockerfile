FROM mcr.microsoft.com/playwright:v1.49.1-jammy

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

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
