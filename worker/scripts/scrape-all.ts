// Scheduled scrape job. For each credential-login portal, runs its recipe
// scraper directly (login → discover → match open cases → download PDF) and
// posts results to the tracker's Pending Upload queue (a human still Approves
// before anything reaches PB). Runs IN the Fly scheduled machine itself — no
// call back to the HTTP worker (calling the app's own public URL from inside
// Fly doesn't route). Mirrors the /run handler's logic on purpose; if this and
// /run ever drift, extract a shared runLab().
//
// Portals needing a session file (Genova) or a multi-step flow (Vibrant) are
// excluded by default; SCRAPE_LABS overrides the list.

import { chromium } from "playwright";

import { loadEnvLocal } from "../src/lib/load-env.js";
import { materializePortalSessions } from "../src/lib/portal-sessions.js";
import { loadRecipes } from "../src/recipes/load.js";
import { makeRecipeScraper } from "../src/recipes/runner.js";
import { fetchOpenCases, postResultReady } from "../src/tracker-client.js";
import { reportHeartbeat } from "../src/lib/heartbeat.js";
import { vibrantScraper } from "../src/scrapers/vibrant.js";
import type { LabScraper } from "../src/scrapers/base.js";

loadEnvLocal();
materializePortalSessions();

// Hand-written scrapers (not recipes). Vibrant is pure-HTTP/api-token (no session
// file), so it runs headless on Fly like the recipe portals.
const HANDWRITTEN: Record<string, LabScraper> = { vibrant: vibrantScraper };

const LABS = (process.env.SCRAPE_LABS ?? "access,cyrex,spectracell,glycanage,doctorsdata,vibrant")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// PATIENT SAFETY: these labs drip partial results (a Vibrant Zoomer's sections,
// Access blood panels). The scraper can pull a finished section while the rest
// of the order is still pending — we CANNOT confirm order-level completeness
// from the portal yet (needs a HAR capture of the report-status pending count).
// So anything auto-pulled for these is staged as PARTIAL (step 2), never auto-
// completed (step 4) — the human confirms completeness at Approve. A complete
// report mis-labeled "partial" is a harmless nuisance; a partial mis-labeled
// "complete" fires the all-done cascade + posts an incomplete lab. See TASKS.md.
const PARTIAL_PRONE_LABS = new Set(["vibrant", "access"]);

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function scrapeLab(labKey: string): Promise<void> {
  let scraper: LabScraper | undefined = HANDWRITTEN[labKey];
  if (!scraper) {
    const recipe = (await loadRecipes()).find((r) => r.key === labKey);
    if (!recipe) {
      log(`${labKey}: no recipe or hand-written scraper — skipped`);
      return;
    }
    scraper = makeRecipeScraper(recipe);
  }
  const cases = await fetchOpenCases(scraper.labName);
  if (cases.length === 0) {
    log(`${labKey}: 0 open cases`);
    return;
  }
  const browser = await chromium.launch({ headless: true });
  let posted = 0;
  const errors: Array<{ caseId: string; message: string }> = [];
  try {
    const run = await scraper.run(browser, cases);
    errors.push(...run.errors);
    for (const r of run.found) {
      try {
        await postResultReady({
          caseId: r.caseId,
          labExternalRef: r.labExternalRef,
          pdfBase64: r.pdfBase64,
          pdfFilename: r.pdfFilename,
          resultIssuedAt: r.resultIssuedAt,
          source: `worker:${labKey}`,
          // Drip labs stage as partial unless the scraper proves completeness.
          isPartial: PARTIAL_PRONE_LABS.has(labKey) || Boolean(r.isPartial),
          portalPatientName: r.portalPatientName,
        });
        posted += 1;
      } catch (err) {
        errors.push({ caseId: r.caseId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    await browser.close();
  }
  log(`${labKey}: checked ${cases.length}, posted ${posted}, errors ${errors.length}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  for (const lab of LABS) {
    try {
      await scrapeLab(lab);
      await reportHeartbeat(`scrape:${lab}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${lab}: FATAL ${msg}`);
      await reportHeartbeat(`scrape:${lab}`, { status: "error", error: msg });
    }
  }
  // Whole-cycle liveness — the watchdog alerts if this stops landing.
  await reportHeartbeat("scrape-loop");
}

async function main() {
  // `--loop` (used by the Fly `scrape` process) keeps scraping every
  // SCRAPE_LOOP_MS so newly-ready results get pulled + staged for Approve
  // without a manual trigger. Bare invocation stays one-shot (manual runs).
  const loop = process.argv.includes("--loop");
  if (!loop) {
    log(`scrape-all (once) → ${LABS.join(", ")}`);
    await runOnce();
    log("scrape-all done");
    return;
  }
  const intervalMs = Number(process.env.SCRAPE_LOOP_MS ?? String(60 * 60 * 1000)); // 1h
  log(`scrape-all loop: every ${intervalMs}ms → ${LABS.join(", ")}`);
  await sleep(8000); // let app + sibling processes settle after a deploy
  for (;;) {
    await runOnce();
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
