// Lab-name normalization. Staff type free-text lab names ("Access Custom",
// "access · custom", "Vibrant · EBOO Waste") that don't equal the scraper's
// canonical portal key ("Access", "Vibrant"). This maps a raw lab name to its
// canonical portal so case→scraper matching, Zenoti adoption, and name-probing
// all line up. Unknown labs (Kennedy Krieger, ReliGen, Peptides, Viome…) pass
// through trimmed — they have no scraper.

const PORTALS = ["Access", "Cyrex", "Spectracell", "Genova", "GlycanAge", "DoctorsData", "Vibrant"] as const;

// Scraper keys the worker exposes at POST /probe/:lab and /run/:lab — the
// canonical portal name lower-cased. Mirrors the worker's resolveScrapers()
// set (handwritten Vibrant + the recipe catalog).
const PROBE_KEYS: ReadonlySet<string> = new Set(PORTALS.map((p) => p.toLowerCase()));

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The worker scraper key a lab maps to, or null when no scraper covers it
 * (Kennedy Krieger, ReliGen, Peptides, …). Gates the name-probe "Find result"
 * button — there's nothing to probe for a portal we can't scrape. */
export function probeKeyForLab(labName: string | null | undefined): string | null {
  const key = normalizeLabName(labName).toLowerCase();
  return PROBE_KEYS.has(key) ? key : null;
}

/** Map a raw lab name to its canonical scraper portal, or trimmed raw if none. */
export function normalizeLabName(raw: string | null | undefined): string {
  if (!raw) return "";
  const c = canon(raw);
  for (const p of PORTALS) {
    if (c.includes(canon(p))) return p;
  }
  return raw.trim();
}

/** True when two lab names refer to the same portal. */
export function sameLab(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeLabName(a);
  const nb = normalizeLabName(b);
  return na.length > 0 && na.toLowerCase() === nb.toLowerCase();
}

/** Loose patient-name equality: case-insensitive, whitespace-collapsed. Does NOT
 * reorder words (so "Chen Hall" ≠ "Halland Chen" — those are genuinely different
 * after a name change, and we'd rather not adopt the wrong card). */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}
