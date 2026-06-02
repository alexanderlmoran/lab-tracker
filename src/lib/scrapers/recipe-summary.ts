// Display mirror of the worker recipe catalog (worker/src/recipes/catalog.ts).
//
// The worker is the single source of truth, but the app's tsconfig excludes
// worker/ (the monorepo build trap), so this read-only summary is mirrored here
// purely to render the Settings → Scrapers "Recipe engine" view. Contains NO
// secrets — just strategy names + transport. Keep in sync when catalog.ts changes.
// (Phase 3 end-state: recipes move to the DB and this mirror goes away.)

export type RecipeEngineStatus = "recipe" | "hand-written";

export type RecipeSummaryRow = {
  key: string;
  labName: string;
  status: RecipeEngineStatus;
  transport: "http" | "browser" | "—";
  auth: string;
  discovery: string;
  pdf: string;
  note?: string;
};

export const RECIPE_SUMMARY: RecipeSummaryRow[] = [
  { key: "glycanage", labName: "GlycanAge", status: "recipe", transport: "http", auth: "firebase", discovery: "rest-json", pdf: "http-get-stream-slice" },
  { key: "doctorsdata", labName: "DoctorsData", status: "recipe", transport: "http", auth: "aspnet-form", discovery: "datatables", pdf: "http-get" },
  { key: "genova", labName: "Genova", status: "recipe", transport: "http", auth: "session-cookies", discovery: "csrf-json", pdf: "http-get", note: "reCAPTCHA login — periodic session refresh" },
  { key: "cyrex", labName: "Cyrex", status: "recipe", transport: "browser", auth: "browser-form", discovery: "dom-search", pdf: "browser-download" },
  { key: "spectracell", labName: "Spectracell", status: "recipe", transport: "browser", auth: "browser-form", discovery: "dom-inbox", pdf: "browser-download", note: "slow site; activate-row select" },
  { key: "access", labName: "Access", status: "recipe", transport: "browser", auth: "browser-form", discovery: "dom-inbox", pdf: "browser-network-intercept", note: "Chrome PDF-viewer trap" },
  { key: "vibrant", labName: "Vibrant", status: "hand-written", transport: "http", auth: "api-token", discovery: "findPatient", pdf: "pdf-engine", note: "multi-step per-case API — doesn't fit the engine yet" },
];

export function recipeEngineCoverage(): { total: number; recipes: number } {
  return { total: RECIPE_SUMMARY.length, recipes: RECIPE_SUMMARY.filter((r) => r.status === "recipe").length };
}
