// Post-deploy smoke test — catches the two prod-only regression classes a local
// build can't:
//   #18  API routes silently DROPPED from the deploy (they 404 in prod while the
//        build passes locally — the .vercelignore incident).
//   #20  the PDF pipeline dying ONLY on Vercel (the DOMMatrix incident).
//
// Run after every app deploy (exits non-zero on any failure so it can gate CI):
//   npx tsx scripts/smoke.ts                        # defaults to prod
//   npx tsx scripts/smoke.ts https://centnerlabs.com
//   WORKER_SHARED_SECRET=… npx tsx scripts/smoke.ts # also runs the deep checks
//
// See docs/INCIDENTS.md (#18, #20) and docs/ARCHITECTURE.md → Deploy / ops.

import { readFileSync } from "node:fs";

// Load .env.local so the deep check finds WORKER_SHARED_SECRET/CRON_SECRET when
// run locally (CI / Vercel already have real env). Mirrors scripts/db.ts.
function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* rely on real env */
  }
}
loadEnvLocal();

const BASE = (
  process.argv[2] ||
  process.env.SMOKE_BASE_URL ||
  process.env.TRACKER_BASE_URL ||
  "https://centnerlabs.com"
).replace(/\/+$/, "");
const SECRET = process.env.WORKER_SHARED_SECRET || process.env.CRON_SECRET || "";

// Routes that MUST exist in prod. A 404 = dropped from the deploy (#18). Any
// other status (401 unauth, 405 wrong method, 3xx redirect, 200) proves it shipped.
const ROUTES = [
  "/api/worker/open-cases",
  "/api/worker/result-ready",
  "/api/worker/pb-upload/next",
  "/api/worker/cases",
  "/api/worker/heartbeat",
  "/api/worker/iv-sessions",
  "/api/worker/result-upload-url",
  "/api/cron/refresh-tracking",
  "/api/cron/heartbeat-watch",
  "/api/cron/integrity-audit",
];

type Result = { name: string; ok: boolean; detail: string };

async function probeExists(path: string): Promise<Result> {
  try {
    const res = await fetch(BASE + path, { method: "GET", redirect: "manual" });
    const ok = res.status !== 404;
    return {
      name: `route ${path}`,
      ok,
      detail: ok ? `exists (HTTP ${res.status})` : "MISSING (404 — dropped from deploy)",
    };
  } catch (e) {
    return { name: `route ${path}`, ok: false, detail: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Deep checks reuse the existing watchdog endpoint, which now also self-tests the
// PDF pipeline (#20) + probes schema drift + loop heartbeats. Needs the secret.
async function deepChecks(): Promise<Result> {
  if (!SECRET) {
    return {
      name: "deep checks (PDF + drift + heartbeats)",
      ok: true,
      detail: "SKIPPED — set WORKER_SHARED_SECRET or CRON_SECRET to enable",
    };
  }
  try {
    const res = await fetch(`${BASE}/api/cron/heartbeat-watch`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      pdfPipeline?: string | null;
      drift?: string[];
      stale?: Array<{ label: string }>;
    };
    const problems: string[] = [];
    if (body.pdfPipeline) problems.push(`PDF pipeline: ${body.pdfPipeline}`);
    if (body.drift?.length) problems.push(`migration drift: ${body.drift.join(", ")}`);
    if (body.stale?.length) problems.push(`loops down: ${body.stale.map((s) => s.label).join(", ")}`);
    const ok = body.ok === true;
    return {
      name: "deep checks (PDF + drift + heartbeats)",
      ok,
      detail: ok ? "all clear" : problems.join(" | ") || `heartbeat-watch not-ok (HTTP ${res.status})`,
    };
  } catch (e) {
    return { name: "deep checks (heartbeat-watch)", ok: false, detail: `call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

(async () => {
  console.log(`smoke: ${BASE}\n`);
  const results: Result[] = [];
  for (const r of ROUTES) results.push(await probeExists(r));
  results.push(await deepChecks());
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${failed === 0 ? "✓ all passed" : `✗ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
