import Fastify from "fastify";
import { chromium } from "playwright";
import { fetchOpenCases, postResultReady } from "./tracker-client.js";
import { withLock } from "./lib/lock.js";
import { vibrantScraper } from "./scrapers/vibrant.js";
import { makeRecipeScraper } from "./recipes/runner.js";
import { loadRecipes } from "./recipes/load.js";
import type { LabScraper } from "./scrapers/base.js";

// Hand-written scrapers that aren't recipes. Vibrant only — a multi-step per-case
// API (login -> findPatient -> getReportStatus -> pdf-engine URL) that doesn't fit
// the auth->list->fetch recipe model.
const HANDWRITTEN: Record<string, LabScraper> = {
  vibrant: vibrantScraper,
};

// Resolve the active scraper set: hand-written + recipe-backed (built-in catalog
// merged with DB overrides, cached by loadRecipes). All recipe portals are
// live-verified byte-equivalent to their old hand-written versions; Genova needs
// a periodically-refreshed session (GENOVA_SESSION_PATH; reCAPTCHA login).
async function resolveScrapers(): Promise<Record<string, LabScraper>> {
  const recipes = await loadRecipes();
  const map: Record<string, LabScraper> = { ...HANDWRITTEN };
  for (const r of recipes) map[r.key] = makeRecipeScraper(r);
  return map;
}

const SECRET = process.env.WORKER_SHARED_SECRET;
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true }));

app.post<{ Params: { lab: string } }>("/run/:lab", async (req, reply) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${SECRET}`) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }

  const labKey = req.params.lab.toLowerCase();
  const scrapers = await resolveScrapers();
  const scraper = scrapers[labKey];
  if (!scraper) {
    return reply.code(404).send({ ok: false, error: `unknown lab: ${labKey}` });
  }

  const result = await withLock(`scrape:${labKey}`, async () => {
    const cases = await fetchOpenCases(scraper.labName);
    if (cases.length === 0) {
      return { checked: 0, posted: 0, errors: [] };
    }

    const browser = await chromium.launch({ headless: true });
    let posted = 0;
    let runErrors: Array<{ caseId: string; message: string }> = [];
    try {
      const run = await scraper.run(browser, cases);
      runErrors = run.errors;
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
          runErrors.push({
            caseId: r.caseId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      await browser.close();
    }

    return { checked: cases.length, posted, errors: runErrors };
  });

  if ("skipped" in result) {
    return reply.code(202).send({ ok: true, skipped: true, reason: "already running" });
  }
  return reply.send({ ok: true, ...result });
});

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
