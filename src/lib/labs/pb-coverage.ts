// Pure PB-coverage classifier — the server-side twin of
// worker/scripts/audit-pb-coverage.ts. Given the complete cases and a slimmed PB
// labrequest roster (shipped from the worker, which has PB egress), decide for
// each case whether its lab is verifiably on the patient's PB chart, and roll
// the verdicts into a snapshot row for lab_audit_runs.
//
// No I/O — the worker fetches PB, the tracker owns the case data; this function
// is the join. Patient resolution is roster-based (name → clientRecord) since
// the tracker can't call PB's search endpoint itself.

export type CoverageCase = {
  patient_name: string;
  patient_dob: string | null;
  lab_name: string | null;
  lab_external_ref: string | null;
  collection_date: string | null;
};

/** Slimmed PB labrequest the worker ships (no PHI beyond what PB already holds). */
export type RosterLabRequest = {
  name: string;
  dateOrdered: string | null;
  clientId: string | null;
  firstName: string | null;
  lastName: string | null;
};

export type Verdict = "STRONG" | "LIKELY" | "MISSING" | "NO_MATCH";

export type CoverageSnapshot = {
  total: number;
  strong: number;
  likely: number;
  missing: number;
  no_match: number;
  coverage_pct: number | null; // (strong + likely) / total * 100
  gaps: Array<{ patient: string; lab: string; verdict: Verdict }>;
};

const VENDOR_ALIASES: Record<string, string[]> = {
  vibrant: ["vibrant", "zoomer", "eboo", "total tox", "tickborne", "immunoglobulin", "neural", "gut "],
  access: ["access"],
  doctorsdata: ["doctorsdata", "doctors data", "doctor's data", "chelation"],
  glycanage: ["glycanage"],
  cyrex: ["cyrex"],
  spectracell: ["spectracell", "spectra", "micronutrient", "telomere"],
  genova: ["genova", "gi effects", "gdx"],
  viome: ["viome"],
  rgcc: ["rgcc", "maintrac"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function labTokens(labName: string | null): string[] {
  if (!labName) return [];
  const ln = labName.toLowerCase();
  const base = (ln.split(/[\s·—-]+/)[0] ?? "").replace(/[^a-z]/g, "");
  const tokens = new Set<string>(VENDOR_ALIASES[base] ?? (base ? [base] : []));
  if (ln.includes("eboo")) tokens.add("eboo");
  return [...tokens];
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

function parseName(full: string): { firsts: string[]; last: string } {
  const parenFirsts = [...full.matchAll(/\(([^)]+)\)/g)].map((m) => norm(m[1])).filter(Boolean);
  const bare = full.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  let tokens: string[];
  if (bare.includes(",")) {
    const [last, rest] = bare.split(",");
    tokens = [...(rest ?? "").trim().split(/\s+/), last.trim()];
  } else {
    tokens = bare.split(/\s+/);
  }
  tokens = tokens.map(norm).filter(Boolean);
  const last = tokens.at(-1) ?? "";
  const firsts = [...new Set([tokens[0] ?? "", ...parenFirsts].filter(Boolean))];
  return { firsts, last };
}

type RosterRec = { id: string; first: string; last: string };

function rosterMatch(caseName: string, roster: RosterRec[]): string | null {
  const { firsts, last } = parseName(caseName);
  if (!last) return null;
  const sameSurname = roster.filter((r) => r.last === last);
  // Prefer an exact first-name match (disambiguates common surnames — "darica
  // smith" among several Smiths); only fall back to first-initial if none exact.
  let hits = sameSurname.filter((r) => firsts.includes(r.first));
  if (hits.length === 0) {
    hits = sameSurname.filter((r) => firsts.some((f) => f && r.first && f[0] === r.first[0]));
  }
  const ids = [...new Set(hits.map((h) => h.id))];
  return ids.length === 1 ? ids[0] : null;
}

function classify(c: CoverageCase, lrs: RosterLabRequest[]): Verdict {
  const acc = (c.lab_external_ref ?? "").trim();
  if (acc && lrs.some((lr) => (lr.name ?? "").includes(acc))) return "STRONG";
  const tokens = labTokens(c.lab_name);
  const likely = lrs.some((lr) => {
    const n = (lr.name ?? "").toLowerCase();
    if (tokens.length && !tokens.some((t) => n.includes(t))) return false;
    const d = daysApart(lr.dateOrdered, c.collection_date);
    if (d !== null) return d <= 90;
    return tokens.length > 0;
  });
  return likely ? "LIKELY" : "MISSING";
}

export function computeCoverage(
  cases: CoverageCase[],
  labrequests: RosterLabRequest[],
): CoverageSnapshot {
  // Unique PB records seen across the roster.
  const roster: RosterRec[] = [];
  const seen = new Set<string>();
  for (const lr of labrequests) {
    if (!lr.clientId || seen.has(lr.clientId)) continue;
    seen.add(lr.clientId);
    roster.push({ id: lr.clientId, first: norm(lr.firstName ?? ""), last: norm(lr.lastName ?? "") });
  }
  const byClient = new Map<string, RosterLabRequest[]>();
  for (const lr of labrequests) {
    if (!lr.clientId) continue;
    (byClient.get(lr.clientId) ?? byClient.set(lr.clientId, []).get(lr.clientId)!).push(lr);
  }

  const tally = { strong: 0, likely: 0, missing: 0, no_match: 0 };
  const gaps: CoverageSnapshot["gaps"] = [];
  for (const c of cases) {
    const pid = rosterMatch(c.patient_name, roster);
    let verdict: Verdict;
    if (!pid) verdict = "NO_MATCH";
    else verdict = classify(c, byClient.get(pid) ?? []);
    if (verdict === "STRONG") tally.strong++;
    else if (verdict === "LIKELY") tally.likely++;
    else {
      if (verdict === "MISSING") tally.missing++;
      else tally.no_match++;
      gaps.push({ patient: c.patient_name, lab: c.lab_name ?? "", verdict });
    }
  }
  const total = cases.length;
  const verified = tally.strong + tally.likely;
  return {
    total,
    ...tally,
    coverage_pct: total === 0 ? null : Math.round((verified / total) * 1000) / 10,
    gaps,
  };
}
