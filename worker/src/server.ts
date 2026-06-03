import Fastify from "fastify";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenCases, postResultReady } from "./tracker-client.js";
import { withLock } from "./lib/lock.js";
import { vibrantScraper } from "./scrapers/vibrant.js";
import { makeRecipeScraper } from "./recipes/runner.js";
import { loadRecipes } from "./recipes/load.js";
import { RECIPES } from "./recipes/catalog.js";
import { uploadPdfToPb } from "./uploaders/practicebetter.js";
import { materializePortalSessions } from "./lib/portal-sessions.js";
import type { LabScraper, ScrapeResult } from "./scrapers/base.js";

// On Fly, decode any *_SESSION_B64 secrets to temp files + set *_SESSION_PATH so
// session-gated scrapers (Genova) find their cookies. No-op locally.
materializePortalSessions();

// Where the post-test saves scraped PDFs for reuse (gitignored — may be PHI).
const POST_TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "captures", "post-test");

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

// Phase 3 (3/3b): the app→worker channel for the Settings "Test" button. Resolves
// a recipe through loadRecipes() (so DB overrides are reflected), reports where it
// came from + whether it builds, and — with ?dryRun=1 — actually runs it against
// open cases WITHOUT posting anything to the tracker. Same Bearer auth as /run.
app.post<{ Params: { lab: string }; Querystring: { dryRun?: string } }>(
  "/test/:lab",
  async (req, reply) => {
    if ((req.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const labKey = req.params.lab.toLowerCase();

    // Hand-written scrapers (Vibrant) aren't recipes — nothing to resolve/build.
    if (HANDWRITTEN[labKey]) {
      return reply.send({
        ok: true,
        key: labKey,
        labName: HANDWRITTEN[labKey].labName,
        source: "hand-written",
        transport: "n/a",
        builds: true,
      });
    }

    const recipe = (await loadRecipes()).find((r) => r.key === labKey);
    if (!recipe) {
      return reply.code(404).send({ ok: false, error: `unknown lab: ${labKey}` });
    }
    // loadRecipes returns catalog objects by reference when not overridden, so a
    // reference mismatch means a DB row replaced the built-in for this key.
    const builtin = RECIPES.find((r) => r.key === labKey);
    const source = !builtin ? "db-only" : recipe === builtin ? "built-in" : "db-override";

    let builds = true;
    let buildError: string | undefined;
    try {
      makeRecipeScraper(recipe);
    } catch (err) {
      builds = false;
      buildError = err instanceof Error ? err.message : String(err);
    }

    const base = {
      ok: builds,
      key: recipe.key,
      labName: recipe.labName,
      source,
      transport: recipe.transport,
      strategies: {
        auth: recipe.auth.strategy,
        discovery: recipe.discovery.strategy,
        pdf: recipe.pdf.strategy,
      },
      builds,
      ...(buildError ? { buildError } : {}),
    };

    if (req.query?.dryRun !== "1" || !builds) return reply.send(base);

    // Dry run: execute the scraper against open cases but DO NOT post results.
    const scraper = makeRecipeScraper(recipe);
    const dry = await withLock(`scrape:${labKey}`, async () => {
      const cases = await fetchOpenCases(scraper.labName);
      if (cases.length === 0) return { checked: 0, found: [], errors: [] };
      const browser = await chromium.launch({ headless: true });
      try {
        const run = await scraper.run(browser, cases);
        return {
          checked: cases.length,
          found: run.found.map((f) => ({
            caseId: f.caseId,
            labExternalRef: f.labExternalRef,
            pdfFilename: f.pdfFilename,
            pdfBytes: f.pdfBase64 ? Buffer.from(f.pdfBase64, "base64").length : 0,
            resultIssuedAt: f.resultIssuedAt,
          })),
          errors: run.errors,
        };
      } finally {
        await browser.close();
      }
    });

    if (dry && "skipped" in dry) {
      return reply.send({ ...base, dryRun: { skipped: true, reason: "already running" } });
    }
    return reply.send({ ...base, dryRun: dry });
  },
);

// Phase 3 post-test: full pipeline (scrape → save PDF → PB upload) for ONE
// nominated test patient only. Hard-guarded so it can never write to anyone
// else's PB chart. Title is tagged "TEST", patient email suppressed, and the
// scraped PDF is saved under captures/post-test/ for future reuse.
app.post<{ Params: { lab: string } }>("/post-test/:lab", async (req, reply) => {
  if ((req.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }

  const testName = process.env.PB_TEST_PATIENT_NAME;
  const testDob = process.env.PB_TEST_PATIENT_DOB || undefined;
  const testPatientId = process.env.PB_TEST_PATIENT_ID || undefined;
  const pbUser = process.env.PB_USERNAME;
  const pbPass = process.env.PB_PASSWORD;
  const consultantId = process.env.PB_CONSULTANT_ID;
  if (!testName || !pbUser || !pbPass || !consultantId) {
    return reply.code(412).send({
      ok: false,
      error:
        "post-test not configured (needs PB_TEST_PATIENT_NAME, PB_USERNAME, PB_PASSWORD, PB_CONSULTANT_ID)",
    });
  }

  const labKey = req.params.lab.toLowerCase();
  const scrapers = await resolveScrapers();
  const scraper = scrapers[labKey];
  if (!scraper) {
    return reply.code(404).send({ ok: false, error: `unknown lab: ${labKey}` });
  }

  // Synthetic case for the TEST patient ONLY — never a real open case. With no
  // ref the runner matches by name+dob, so this works across portals.
  const testCase = {
    caseId: "post-test",
    patientName: testName,
    patientDob: testDob ?? null,
    patientEmail: "",
    labName: scraper.labName,
    labExternalRef: null,
    sampleSentAt: null,
    trackingDeliveredAt: null,
    expectedResultAtMin: null,
    expectedResultAtMax: null,
  };

  const browser = await chromium.launch({ headless: true });
  let found: ScrapeResult | undefined;
  let runErrors: Array<{ caseId: string; message: string }> = [];
  try {
    const run = await scraper.run(browser, [testCase]);
    found = run.found[0];
    runErrors = run.errors;
  } finally {
    await browser.close();
  }

  if (!found) {
    return reply.send({
      ok: false,
      error: `no result found on ${scraper.labName} for test patient "${testName}"`,
      errors: runErrors,
    });
  }

  // Save the scraped PDF in-program for future reuse.
  await mkdir(POST_TEST_DIR, { recursive: true });
  const pdfFilename = found.pdfFilename || `${labKey}-test.pdf`;
  const savePath = join(POST_TEST_DIR, pdfFilename);
  const pdfBytes = Buffer.from(found.pdfBase64, "base64");
  await writeFile(savePath, pdfBytes);

  // Upload to PB — guarded so it can ONLY land on the nominated test patient.
  const result = await uploadPdfToPb({
    username: pbUser,
    password: pbPass,
    consultantId,
    patientName: testName,
    patientDob: testDob,
    expectedPatientId: testPatientId,
    labName: `TEST — ${scraper.labName} ${found.resultIssuedAt?.slice(0, 10) ?? ""}`.trim(),
    dateOrdered: found.resultIssuedAt ?? new Date().toISOString(),
    pdfPath: savePath,
    pdfFilename,
    isClientFacing: false,
    notify: false,
  });

  return reply.send({
    ok: true,
    lab: scraper.labName,
    testPatient: testName,
    labRequestId: result.labRequestId,
    patientId: result.patientId,
    pdfSaved: savePath,
    scraped: { ref: found.labExternalRef, bytes: pdfBytes.length, filename: pdfFilename },
    errors: runErrors,
  });
});

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
