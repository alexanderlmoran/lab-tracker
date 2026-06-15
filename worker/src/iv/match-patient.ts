// Patient-identity confidence scorer for IV note auto-posting.
//
// Mirrors the reconcile engine's philosophy (multi-signal, threshold-gated)
// but for PATIENT IDENTITY rather than lab matching: grade a Zenoti IV session
// against PB patient candidates on name + email + phone + DOB → 0..100, where
// email/phone are UNIQUE identifiers and DOB only corroborates. Auto-post only
// at >= AUTO_POST_THRESHOLD (95) while the engine is unproven; everything else
// holds for human review. Conservative by design — a wrong chart is the risk.
//
// DOB for the session comes from patients_seed (Zenoti appts don't expose it);
// the caller enriches before scoring.

/** What we know about the session's patient (Zenoti + patients_seed enrichment). */
export type PatientIdentity = {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  /** YYYY-MM-DD (or any ISO prefix). */
  dob?: string | null;
  /** Mobile/contact phone (Zenoti gives this on every appt; patients_seed too). */
  phone?: string | null;
};

/** A PB patient candidate (from findPbPatient / records search). */
export type PbCandidate = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  emailAddress?: string | null;
  dayOfBirth?: string | null;
  /** PB exposes homePhone on the records/search profile. */
  phone?: string | null;
};

export const AUTO_POST_THRESHOLD = 95;

// Signal weights. A matching EMAIL or PHONE is a UNIQUE identifier (one person
// per address/number), so name=full + EITHER clears 95 on its own — and that's
// precisely the twins-safe distinguisher (identical twins share name + DOB but
// never the same email/phone). A matching DOB is NOT unique (twins / same-name
// people collide on it), so name+DOB alone stays BELOW the bar and holds for
// review. Zenoti's guest profile rarely carries DOB (optional, collected for
// labs), so anchoring auto-post on email/phone rather than DOB is what unblocks
// IV posting WITHOUT lowering the safety bar. A second unique signal (or DOB)
// only reinforces. Name-only (no unique id) always holds.
const W_NAME_FULL = 45;
const W_NAME_LAST_ONLY = 18;
const W_DOB = 35; // corroborating only — shared by twins, so never auto-posts alone
const W_EMAIL = 50; // unique → name+email = 95, auto-posts (the twins-safe key)
const W_PHONE = 50; // unique → name+phone = 95, auto-posts

const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const dobKey = (s?: string | null) => norm(s).slice(0, 10);
/** Last 10 digits of a phone (drops country code / formatting) for comparison. */
const phoneKey = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);

function fullName(p: { fullName?: string | null; firstName?: string | null; lastName?: string | null }): string {
  if (p.fullName && norm(p.fullName)) return norm(p.fullName);
  return norm(`${p.firstName ?? ""} ${p.lastName ?? ""}`);
}

/** Per-field cross-reference result: present in both AND equal (match), present
 *  in both but DIFFERENT (conflict), or absent on a side (none). */
export type FieldState = "match" | "conflict" | "none";
export type MatchSignals = { name: "full" | "last" | "none"; dob: FieldState; email: FieldState; phone: FieldState };

const cmp = (a: string, b: string): FieldState => (!a || !b ? "none" : a === b ? "match" : "conflict");

// A DIFFERENT email is the most reliable "wrong person" signal (emails are unique
// and rarely change for the same patient here), so an email conflict DROPS the
// score and blocks auto-post. DOB/phone conflicts are softer (seed typos, number
// changes) so they don't drop the score; a DOB conflict only blocks when NO
// unique id (email/phone) matched — a unique match proves identity and makes a
// stale DOB just a data error, not a different person.
const P_EMAIL_CONFLICT = 30;

/** Score one candidate 0..100 against the session identity, with the per-field
 *  cross-reference (match/conflict/none) and whether a conflict disqualifies it
 *  from auto-post (audit/explainability — same as the engine logs reasons). */
export function scorePatientMatch(
  session: PatientIdentity,
  cand: PbCandidate,
): { score: number; signals: MatchSignals; hardConflict: boolean } {
  let score = 0;
  let name: MatchSignals["name"] = "none";

  const sName = fullName(session);
  const cName = fullName(cand);
  if (sName && cName && sName === cName) {
    score += W_NAME_FULL;
    name = "full";
  } else {
    const sLast = norm(session.lastName) || sName.split(" ").slice(-1)[0];
    const cLast = norm(cand.lastName) || cName.split(" ").slice(-1)[0];
    if (sLast && cLast && sLast === cLast) {
      score += W_NAME_LAST_ONLY;
      name = "last";
    }
  }

  const email = cmp(norm(session.email), norm(cand.emailAddress));
  if (email === "match") score += W_EMAIL;
  else if (email === "conflict") score -= P_EMAIL_CONFLICT;

  const dob = cmp(dobKey(session.dob), dobKey(cand.dayOfBirth));
  if (dob === "match") score += W_DOB;

  const sPhone = phoneKey(session.phone);
  const cPhone = phoneKey(cand.phone);
  const phone: FieldState =
    sPhone.length < 10 || cPhone.length < 10 ? "none" : sPhone === cPhone ? "match" : "conflict";
  if (phone === "match") score += W_PHONE;

  // An email conflict normally disqualifies (likely the wrong person) — BUT not
  // when a corroborating id (DOB or phone) ALSO matches: name+DOB+phone matching
  // proves identity, so a differing email is a stale/typo'd value, not a different
  // person (e.g. Leila: name+DOB+phone match, only the email differs). The -30
  // email penalty still applies, so a weakly-corroborated conflict stays under 95.
  // A DOB conflict disqualifies ONLY when no unique id (email/phone) matched.
  const emailHardConflict = email === "conflict" && !(dob === "match" || phone === "match");
  const hardConflict = emailHardConflict || (dob === "conflict" && email !== "match" && phone !== "match");

  return { score: Math.max(0, Math.min(100, score)), signals: { name, dob, email, phone }, hardConflict };
}

export type BestMatch = {
  candidate: PbCandidate;
  score: number;
  signals: MatchSignals;
  /** A conflicting unique id (email, or a no-unique-match DOB) — never auto-post. */
  hardConflict: boolean;
  /** True when score >= threshold, the runner-up is clearly behind, AND no conflict. */
  autoPostable: boolean;
  reason: string;
};

/** Pick the best PB candidate and decide if it clears the auto-post bar.
 *  Auto-post requires score >= 95 AND a clear lead over the 2nd-best (≥15) AND
 *  no conflicting unique id — so two same-name people never silently collide and
 *  a same-name STRANGER (different email/DOB) is held for a human to verify. */
export function pickBestMatch(
  session: PatientIdentity,
  candidates: PbCandidate[],
  threshold = AUTO_POST_THRESHOLD,
): BestMatch | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((c) => ({ candidate: c, ...scorePatientMatch(session, c) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1]?.score ?? 0;
  const clearLead = best.score - runnerUp >= 15;
  const autoPostable = best.score >= threshold && clearLead && !best.hardConflict;
  const sig = `name=${best.signals.name},dob=${best.signals.dob},email=${best.signals.email},phone=${best.signals.phone}`;
  const why = best.hardConflict
    ? ", conflicting id — verify patient"
    : best.score >= threshold && !clearLead
      ? `, but runner-up too close (+${best.score - runnerUp})`
      : "";
  const reason = autoPostable
    ? `auto-post: score ${best.score} (${sig}), lead +${best.score - runnerUp}`
    : `hold for review: score ${best.score} (${sig})${why}`;
  return { candidate: best.candidate, score: best.score, signals: best.signals, hardConflict: best.hardConflict, autoPostable, reason };
}
