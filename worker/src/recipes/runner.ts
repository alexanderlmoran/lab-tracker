// Recipe engine — runner. Turns a LabRecipe (data) into a standard LabScraper so
// it drops into server.ts / the worker pipeline unchanged. See types.ts + strategies.ts.

import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "../scrapers/base.js";
import type { DiscoveredRow, LabRecipe } from "./types.js";
import { AUTH_STRATEGIES, DISCOVERY_STRATEGIES, PDF_STRATEGIES } from "./strategies.js";

export function makeRecipeScraper(recipe: LabRecipe): LabScraper {
  return {
    labName: recipe.labName,
    async run(_browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
      if (openCases.length === 0) return { found: [], errors: [] };

      const auth = AUTH_STRATEGIES[recipe.auth.strategy];
      const discover = DISCOVERY_STRATEGIES[recipe.discovery.strategy];
      const fetchPdf = PDF_STRATEGIES[recipe.pdf.strategy];
      if (!auth) throw new Error(`recipe ${recipe.key}: unknown auth strategy ${recipe.auth.strategy}`);
      if (!discover) throw new Error(`recipe ${recipe.key}: unknown discovery strategy ${recipe.discovery.strategy}`);
      if (!fetchPdf) throw new Error(`recipe ${recipe.key}: unknown pdf strategy ${recipe.pdf.strategy}`);

      const authState = await auth(recipe.auth.config);
      const rows = await discover(recipe.discovery.config, authState);

      const found: ScrapeResult[] = [];
      const errors: ScrapeRun["errors"] = [];

      for (const c of openCases) {
        try {
          const match = matchRow(c, rows, recipe);
          if (!match) continue;
          if (!isReady(match, recipe)) continue;

          const buf = await fetchPdf(recipe.pdf.config, authState, match);
          const ref = match.ref ?? c.labExternalRef ?? "report";
          found.push({
            caseId: c.caseId,
            labExternalRef: ref,
            pdfBase64: buf.toString("base64"),
            pdfFilename: `${recipe.key}_${normalizeName(match.name ?? c.patientName).replace(/\s+/g, "_")}_${ref}.pdf`,
            resultIssuedAt: match.resultIssuedAt,
          });
        } catch (err) {
          errors.push({ caseId: c.caseId, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return { found, errors };
    },
  };
}

function isReady(row: DiscoveredRow, recipe: LabRecipe): boolean {
  const r = recipe.ready;
  if (!r || "mode" in r) return true; // presence (default)
  return r.equals.some((e) => (row.status ?? "").toLowerCase().includes(e.toLowerCase()));
}

function matchRow(c: OpenCase, rows: DiscoveredRow[], recipe: LabRecipe): DiscoveredRow | null {
  // Ref-first if the case carries an external ref (and it fits the expected shape).
  if (c.labExternalRef) {
    const shapeOk = !recipe.match?.refLooksLike || new RegExp(recipe.match.refLooksLike).test(c.labExternalRef);
    if (shapeOk) {
      const byRef = rows.find((r) => r.ref?.trim() === c.labExternalRef!.trim());
      if (byRef) return byRef;
    }
  }
  // Then patient name (+ DOB when both sides have it).
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
