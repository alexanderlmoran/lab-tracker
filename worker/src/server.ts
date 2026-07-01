import "./bootstrap-env.js"; // MUST be first — loads .env.local before tracker-client reads env
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
            collectionDate: r.collectionDate,
            source: `worker:${labKey}`,
            portalPatientName: r.portalPatientName,
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
    labName: `TEST — ${scraper.labName}${found.labExternalRef ? ` - Acc#${found.labExternalRef}` : ""}`,
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

// Name-probe: find a result for a card by PATIENT NAME (no accession needed) so
// staff can verify + clear accession-less cards proactively. Scrapes the portal
// for the name and returns the candidate result (ref + date + pdf size) WITHOUT
// posting. Unlike /run, this isn't gated on the case being in the open-cases feed.
app.post<{
  Params: { lab: string };
  Querystring: { name?: string; dob?: string; stageCaseId?: string; acc?: string };
}>(
  "/probe/:lab",
  async (req, reply) => {
    if ((req.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const labKey = req.params.lab.toLowerCase();
    const name = (req.query?.name ?? "").trim();
    if (!name) return reply.code(400).send({ ok: false, error: "name query param required" });
    // When stageCaseId is set, the caller (backlog #6 "search for lab to post")
    // wants the found PDF PULLED + STAGED onto the case for review, not just a
    // ready/not-ready check — so we must download it (skip the no-download
    // probeByName fast path) and post it through the same postResultReady path
    // /run uses. `acc` (the card's accession) disambiguates when the patient
    // has several results.
    const stageCaseId = (req.query?.stageCaseId ?? "").trim();
    const acc = (req.query?.acc ?? "").trim();

    const scraper = (await resolveScrapers())[labKey];
    if (!scraper) return reply.code(404).send({ ok: false, error: `unknown lab: ${labKey}` });

    // Fast path: scrapers that implement probeByName list candidates by name
    // WITHOUT downloading any PDF — so aged results (invisible to the inbox)
    // surface in seconds instead of pulling every report. Access uses this.
    // Skipped when staging — staging needs the actual PDF, so fall through to
    // the full scraper run below.
    if (scraper.probeByName && !stageCaseId) {
      const browser = await chromium.launch({ headless: true });
      try {
        const cands = await scraper.probeByName(browser, name, req.query?.dob || null);
        return reply.send({
          ok: true,
          lab: scraper.labName,
          name,
          found: cands.map((c) => ({
            ref: c.ref,
            pdfBytes: 0,
            pdfFilename: null,
            resultIssuedAt: c.resultIssuedAt,
            collectionDate: c.collectionDate,
            status: c.status,
          })),
          errors: [],
        });
      } catch (err) {
        return reply.send({
          ok: true,
          lab: scraper.labName,
          name,
          found: [],
          errors: [{ caseId: "probe", message: err instanceof Error ? err.message : String(err) }],
        });
      } finally {
        await browser.close();
      }
    }

    // Synthetic case: use the card's accession when it has one (deterministic —
    // findPatientByAccession needs no DOB, so DOB-less cases like an EBOO/Vibrant
    // card still resolve), else fall back to matching by name (+ dob).
    const probeCase = {
      caseId: "probe",
      patientName: name,
      patientDob: req.query?.dob || null,
      patientEmail: "",
      labName: scraper.labName,
      labExternalRef: acc || null,
      sampleSentAt: null,
      trackingDeliveredAt: null,
      expectedResultAtMin: null,
      expectedResultAtMax: null,
    };

    const browser = await chromium.launch({ headless: true });
    try {
      const run = await scraper.run(browser, [probeCase]);

      // Stage the found PDF onto the real case so it lands in the review-PDF
      // step (same path as /run). Pick the report whose accession matches the
      // card's `acc`; if none match but exactly one report was found, take it
      // (covers accession-format mismatches — the name-probe is authoritative).
      // Multiple non-matching reports → ambiguous, stage nothing.
      let staged = 0;
      const stageErrors: Array<{ caseId: string; message: string }> = [];
      if (stageCaseId) {
        const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, "").trim();
        const withPdf = run.found.filter((f) => f.pdfBase64);
        const matched = acc ? withPdf.filter((f) => norm(f.labExternalRef) === norm(acc)) : [];
        const toStage = matched.length > 0 ? matched : withPdf.length === 1 ? withPdf : [];
        for (const f of toStage) {
          try {
            // Accession-matched stage = staff just entered THIS accession and
            // the portal returned its exact report — auto-approve straight to
            // PB (Salvatore Didonato 2026-06-11: the extra Approve click after
            // a deliberate search was redundant). The single-report FALLBACK
            // (accession didn't match — format mismatch heuristic) still waits
            // in Pending Upload for human review.
            const accMatched = matched.includes(f);
            await postResultReady({
              caseId: stageCaseId,
              labExternalRef: f.labExternalRef ?? (acc || null),
              pdfBase64: f.pdfBase64,
              pdfFilename: f.pdfFilename,
              resultIssuedAt: f.resultIssuedAt,
              collectionDate: f.collectionDate,
              source: `manual-probe:${labKey}`,
              portalPatientName: f.portalPatientName,
              autoApprove: accMatched,
            });
            staged += 1;
          } catch (err) {
            stageErrors.push({
              caseId: stageCaseId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      return {
        ok: true,
        lab: scraper.labName,
        name,
        found: run.found.map((f) => ({
          ref: f.labExternalRef,
          pdfBytes: f.pdfBase64 ? Buffer.from(f.pdfBase64, "base64").length : 0,
          pdfFilename: f.pdfFilename,
          resultIssuedAt: f.resultIssuedAt,
        })),
        staged,
        errors: [...run.errors, ...stageErrors],
      };
    } finally {
      await browser.close();
    }
  },
);

// Debug: dump the RAW Zenoti setDate rows for a day so "why didn't appt X sync?"
// is answered with DATA, not ssh-machine-hunting (the session is materialized here
// at boot; a fresh ssh shell doesn't inherit the secret). Redacted — returns the
// CENTER it queries + service names + first-name/last-initial only, enough to see
// WHICH center's appointments the sync actually receives without dumping full PHI.
app.get<{ Querystring: { date?: string } }>("/debug/zenoti-day", async (req, reply) => {
  if ((req.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }
  const date = (req.query?.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return reply.code(400).send({ ok: false, error: "date=YYYY-MM-DD required" });
  }
  // The live sync (zenoti-auto-loop) doesn't reuse a stored session — it LOGS IN
  // headless each cycle (ZENOTI_USERNAME/PASSWORD), which is why no process has a
  // ZENOTI_STORAGE_PATH. Do the same here: a fresh login to a temp path, then fetch
  // the exact same way the loop does (same CENTER_ID, same setDate transport).
  const { zenotiLogin } = await import("./zenoti/login.js");
  const { fetchZenotiApptRows, CENTER_ID, ORG_ID } = await import("./zenoti/fetch-browser.js");
  const { resolveLabName } = await import("./zenoti/lab-mapping.js");
  const storagePath = "/tmp/debug-zenoti-session.json";
  let cookieCount = 0;
  try {
    cookieCount = await zenotiLogin(storagePath);
  } catch (e) {
    return reply.code(502).send({ ok: false, error: `zenoti login failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  const rows = await fetchZenotiApptRows({ storagePath, date, includeCancelled: true });
  const redact = (full: string) => {
    const parts = full.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "(no name)";
    return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  };
  const svcCounts: Record<string, number> = {};
  for (const r of rows) {
    const s = r.servicename ?? "(none)";
    svcCounts[s] = (svcCounts[s] ?? 0) + 1;
  }
  return reply.send({
    ok: true,
    loginCookies: cookieCount,
    center: CENTER_ID,
    org: ORG_ID,
    date,
    totalRows: rows.length,
    labRows: rows.filter((r) => resolveLabName(r.servicename ?? "")).length,
    services: Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    appts: rows.map((r) => ({
      who: redact((r.Name ?? `${r.FName ?? ""} ${r.LName ?? ""}`).trim() || ""),
      service: r.servicename ?? "(none)",
      lab: resolveLabName(r.servicename ?? "") ?? null,
      cancelled: Number(r.cancelOrNoShowStatus ?? "0") !== 0,
      start: r.starttime ?? null,
    })),
  });
});

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
