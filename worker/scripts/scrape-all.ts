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

loadEnvLocal();
materializePortalSessions();

const LABS = (process.env.SCRAPE_LABS ?? "access,cyrex,spectracell,glycanage,doctorsdata")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function scrapeLab(labKey: string): Promise<void> {
  const recipe = (await loadRecipes()).find((r) => r.key === labKey);
  if (!recipe) {
    log(`${labKey}: no recipe (hand-written or unknown) — skipped`);
    return;
  }
  const scraper = makeRecipeScraper(recipe);
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

async function main() {
  log(`scrape-all → ${LABS.join(", ")}`);
  for (const lab of LABS) {
    try {
      await scrapeLab(lab);
    } catch (err) {
      log(`${lab}: FATAL ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log("scrape-all done");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
