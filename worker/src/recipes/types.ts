// Recipe engine — core types. A LabRecipe is data that selects a strategy per
// axis (auth / discovery / pdf) + that strategy's config. Strategies are reusable
// code (registered in strategies.ts); the runner (runner.ts) wires them into a
// standard LabScraper. See docs/RECIPE_ENGINE_DESIGN.md.

// A discovered result row, normalized across portals. Discovery strategies map a
// portal's raw record onto these fields; `raw` keeps the original for debugging.
export type DiscoveredRow = {
  ref?: string; // external ref (accession/order#/kit) — matching + labExternalRef
  name?: string; // patient name (any of "Last, First" / "First Last")
  dob?: string; // patient DOB if the portal exposes it
  status?: string; // readiness signal ("Complete"/"Released"/"Completed"/…)
  pdfRef?: string; // value the pdf strategy needs (report id, full URL, etc.)
  resultIssuedAt?: string; // ISO date if available
  raw: unknown;
};

// What an auth strategy hands to discovery + pdf strategies.
export type AuthState = {
  cookieHeader?: string;
  bearer?: string;
  // Free-form extras a strategy may need downstream (e.g. an anti-forgery token).
  extra?: Record<string, string>;
};

export type HttpAuthStrategy = (config: Record<string, unknown>) => Promise<AuthState>;
// Discovery lists the portal's recent results (a wide window); the runner matches
// cases client-side. (Per-case search can be added later if a portal needs it.)
export type HttpDiscoveryStrategy = (
  config: Record<string, unknown>,
  auth: AuthState,
) => Promise<DiscoveredRow[]>;
export type HttpPdfStrategy = (
  config: Record<string, unknown>,
  auth: AuthState,
  row: DiscoveredRow,
) => Promise<Buffer>;

// --- Phase 2: browser transport. Strategies operate on a Playwright Page. ---
// (Page typed as unknown here to keep this file playwright-free; strategies cast.)
export type BrowserAuthStrategy = (page: unknown, config: Record<string, unknown>) => Promise<void>;
// dom-inbox ignores searchTerm (reads all rows once); dom-search uses it (per case).
export type BrowserDiscoveryStrategy = (
  page: unknown,
  config: Record<string, unknown>,
  searchTerm: string | null,
) => Promise<DiscoveredRow[]>;
export type BrowserPdfStrategy = (
  page: unknown,
  config: Record<string, unknown>,
  row: DiscoveredRow,
) => Promise<Buffer>;

export type LabRecipe = {
  /** SCRAPERS registry key (e.g. "glycanage"). */
  key: string;
  /** Must equal lab_cases.lab_name for this portal (e.g. "GlycanAge"). */
  labName: string;
  transport: "http" | "browser";
  auth: { strategy: string; config: Record<string, unknown> };
  discovery: {
    strategy: string;
    config: Record<string, unknown>;
    /** Browser only: call discovery once per case with that case's search term. */
    perCase?: boolean;
  };
  pdf: { strategy: string; config: Record<string, unknown> };
  /** Match: ref-first (if the case has labExternalRef) then name (+ dob if present). */
  match?: {
    /** If the case ref must match this shape to be used for ref-search (else name). */
    refLooksLike?: string;
  };
  /** Readiness: row.status in `equals`, or any discovered row counts ("presence"). */
  ready?: { equals: string[] } | { mode: "presence" };
};
