// Recipe engine — runner. Turns a LabRecipe (data) into a standard LabScraper so
// it drops into server.ts / the worker pipeline unchanged. Handles both transports:
// "http" (undici strategies) and "browser" (Playwright strategies).

import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "../scrapers/base.js";
import type { DiscoveredRow, LabRecipe } from "./types.js";
import { AUTH_STRATEGIES, DISCOVERY_STRATEGIES, PDF_STRATEGIES } from "./strategies.js";
import {
  BROWSER_AUTH_STRATEGIES,
  BROWSER_DISCOVERY_STRATEGIES,
  BROWSER_PDF_STRATEGIES,
} from "./strategies-browser.js";

export function makeRecipeScraper(recipe: LabRecipe): LabScraper {
  return {
    labName: recipe.labName,
    async run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
      if (openCases.length === 0) return { found: [], errors: [] };
      return recipe.transport === "browser"
        ? runBrowser(recipe, browser, openCases)
        : runHttp(recipe, openCases);
    },
  };
}

async function runHttp(recipe: LabRecipe, openCases: OpenCase[]): Promise<ScrapeRun> {
  const auth = AUTH_STRATEGIES[recipe.auth.strategy];
  const discover = DISCOVERY_STRATEGIES[recipe.discovery.strategy];
  const fetchPdf = PDF_STRATEGIES[recipe.pdf.strategy];
  assertStrategies(recipe, auth, discover, fetchPdf);

  const authState = await auth(recipe.auth.config);
  const rows = await discover(recipe.discovery.config, authState);

  const found: ScrapeResult[] = [];
  const errors: ScrapeRun["errors"] = [];
  for (const c of openCases) {
    try {
      const match = matchRow(c, rows, recipe);
      if (!match || !isReady(match, recipe)) continue;
      const buf = await fetchPdf(recipe.pdf.config, authState, match);
      found.push(result(recipe, c, match, buf));
    } catch (err) {
      errors.push({ caseId: c.caseId, message: errMsg(err) });
    }
  }
  return { found, errors };
}

async function runBrowser(recipe: LabRecipe, browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
  const auth = BROWSER_AUTH_STRATEGIES[recipe.auth.strategy];
  const discover = BROWSER_DISCOVERY_STRATEGIES[recipe.discovery.strategy];
  const fetchPdf = BROWSER_PDF_STRATEGIES[recipe.pdf.strategy];
  assertStrategies(recipe, auth, discover, fetchPdf);

  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000); // browser portals can be slow (e.g. SpectraCell)

  const found: ScrapeResult[] = [];
  const errors: ScrapeRun["errors"] = [];
  try {
    await auth(page, recipe.auth.config);
    // List-once portals read the grid up front; per-case portals search each case.
    const cached = recipe.discovery.perCase ? null : await discover(page, recipe.discovery.config, null);

    for (const c of openCases) {
      try {
        const term = searchTermFor(c, recipe);
        const rows = recipe.discovery.perCase ? await discover(page, recipe.discovery.config, term) : cached!;
        const match = matchRow(c, rows, recipe);
        if (!match || !isReady(match, recipe)) continue;
        const buf = await fetchPdf(page, recipe.pdf.config, match);
        found.push(result(recipe, c, match, buf));
      } catch (err) {
        errors.push({ caseId: c.caseId, message: errMsg(err) });
      }
    }
  } finally {
    await ctx.close();
  }
  return { found, errors };
}

function assertStrategies(recipe: LabRecipe, a: unknown, d: unknown, p: unknown): void {
  if (!a) throw new Error(`recipe ${recipe.key}: unknown auth strategy ${recipe.auth.strategy}`);
  if (!d) throw new Error(`recipe ${recipe.key}: unknown discovery strategy ${recipe.discovery.strategy}`);
  if (!p) throw new Error(`recipe ${recipe.key}: unknown pdf strategy ${recipe.pdf.strategy}`);
}

function result(recipe: LabRecipe, c: OpenCase, match: DiscoveredRow, buf: Buffer): ScrapeResult {
  const ref = match.ref ?? c.labExternalRef ?? "report";
  return {
    caseId: c.caseId,
    labExternalRef: ref,
    pdfBase64: buf.toString("base64"),
    pdfFilename: `${recipe.key}_${normalizeName(match.name ?? c.patientName).replace(/\s+/g, "_")}_${ref}.pdf`,
    resultIssuedAt: match.resultIssuedAt,
  };
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Term used for per-case browser search: the stored ref if it fits the expected
// shape, else the patient's last name.
function searchTermFor(c: OpenCase, recipe: LabRecipe): string {
  if (c.labExternalRef && (!recipe.match?.refLooksLike || new RegExp(recipe.match.refLooksLike).test(c.labExternalRef))) {
    return c.labExternalRef;
  }
  return lastNameOf(c.patientName);
}

function isReady(row: DiscoveredRow, recipe: LabRecipe): boolean {
  const r = recipe.ready;
  if (!r || "mode" in r) return true; // presence (default)
  return r.equals.some((e) => (row.status ?? "").toLowerCase().includes(e.toLowerCase()));
}

function matchRow(c: OpenCase, rows: DiscoveredRow[], recipe: LabRecipe): DiscoveredRow | null {
  if (c.labExternalRef) {
    const shapeOk = !recipe.match?.refLooksLike || new RegExp(recipe.match.refLooksLike).test(c.labExternalRef);
    if (shapeOk) {
      // A well-formed accession was entered → ONLY its exact result may match.
      // Do NOT fall back to name+dob: if this accession's PDF isn't on the
      // portal yet and the patient has OTHER results in the inbox, a name match
      // would attach the WRONG lab. Better to find nothing and retry next cycle.
      return rows.find((r) => r.ref?.trim() === c.labExternalRef!.trim()) ?? null;
    }
  }
  // No usable accession → match by name (+ dob when both sides have it).
  const nameNorm = normalizeName(c.patientName);
  const dobNorm = normalizeDob(c.patientDob);
  return (
    rows.find((r) => {
      if (normalizeName(r.name ?? "") !== nameNorm) return false;
      const rDob = normalizeDob(r.dob ?? null);
      return dobNorm === "" || rDob === "" || rDob === dobNorm;
    }) ?? null
  );
}

function lastNameOf(patientName: string): string {
  const clean = patientName.replace(/[^a-zA-Z, ]/g, "").trim();
  if (clean.includes(",")) return clean.split(",")[0].trim();
  const parts = clean.split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : clean;
}

function normalizeName(s: string): string {
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}

function normalizeDob(s: string | null): string {
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s.trim();
}
