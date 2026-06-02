import Fastify from "fastify";
import { chromium } from "playwright";
import { fetchOpenCases, postResultReady } from "./tracker-client.js";
import { withLock } from "./lib/lock.js";
import { accessScraper } from "./scrapers/access.js";
import { vibrantScraper } from "./scrapers/vibrant.js";
import { makeRecipeScraper } from "./recipes/runner.js";
import { getRecipe } from "./recipes/catalog.js";
import type { LabScraper } from "./scrapers/base.js";

// Recipe-backed scraper from the config engine (see worker/src/recipes/).
const recipe = (key: string): LabScraper => {
  const r = getRecipe(key);
  if (!r) throw new Error(`no recipe for ${key}`);
  return makeRecipeScraper(r);
};

const SCRAPERS: Record<string, LabScraper> = {
  // Hand-written: Access (network-intercept PDF — last Phase-2 conversion) +
  // multi-step Vibrant API.
  access: accessScraper,
  vibrant: vibrantScraper,
  // Recipe-backed (config engine) — all live-verified byte-equivalent to the
  // hand-written versions. Genova needs a periodically-refreshed session
  // (GENOVA_SESSION_PATH) since its login is reCAPTCHA-gated.
  glycanage: recipe("glycanage"),
  doctorsdata: recipe("doctorsdata"),
  genova: recipe("genova"),
  cyrex: recipe("cyrex"), // browser-transport recipe
  spectracell: recipe("spectracell"), // browser-transport recipe
};

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
  const scraper = SCRAPERS[labKey];
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
