// Patient-identity confidence scorer for IV note auto-posting.
//
// Mirrors the reconcile engine's philosophy (multi-signal, threshold-gated)
// but for PATIENT IDENTITY rather than lab matching: grade a Zenoti IV session
// against PB patient candidates on name + DOB + email → 0..100. Auto-post only
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

// Signal weights — tuned so ANY THREE independent identifiers clear 95 (the safe
// bar): name+dob+email, OR name+email+phone (the no-DOB IV case — DOB is only
// collected for labs), etc. Two signals (e.g. name+email = 75) still hold.
const W_NAME_FULL = 45;
const W_NAME_LAST_ONLY = 18;
const W_DOB = 35;
const W_EMAIL = 30;
const W_PHONE = 25;

const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const dobKey = (s?: string | null) => norm(s).slice(0, 10);
/** Last 10 digits of a phone (drops country code / formatting) for comparison. */
const phoneKey = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);

function fullName(p: { fullName?: string | null; firstName?: string | null; lastName?: string | null }): string {
  if (p.fullName && norm(p.fullName)) return norm(p.fullName);
  return norm(`${p.firstName ?? ""} ${p.lastName ?? ""}`);
}

export type MatchSignals = { name: "full" | "last" | "none"; dob: boolean; email: boolean; phone: boolean };

/** Score one candidate 0..100 against the session identity, with the signals
 *  that fired (for audit/explainability — same as the engine logs reasons). */
export function scorePatientMatch(
  session: PatientIdentity,
  cand: PbCandidate,
): { score: number; signals: MatchSignals } {
  const signals: MatchSignals = { name: "none", dob: false, email: false, phone: false };
  let score = 0;

  const sName = fullName(session);
  const cName = fullName(cand);
  if (sName && cName && sName === cName) {
    score += W_NAME_FULL;
    signals.name = "full";
  } else {
    const sLast = norm(session.lastName) || sName.split(" ").slice(-1)[0];
    const cLast = norm(cand.lastName) || cName.split(" ").slice(-1)[0];
    if (sLast && cLast && sLast === cLast) {
      score += W_NAME_LAST_ONLY;
      signals.name = "last";
    }
  }

  const sDob = dobKey(session.dob);
  const cDob = dobKey(cand.dayOfBirth);
  if (sDob && cDob && sDob === cDob) {
    score += W_DOB;
    signals.dob = true;
  }

  const sEmail = norm(session.email);
  const cEmail = norm(cand.emailAddress);
  if (sEmail && cEmail && sEmail === cEmail) {
    score += W_EMAIL;
    signals.email = true;
  }

  const sPhone = phoneKey(session.phone);
  const cPhone = phoneKey(cand.phone);
  if (sPhone.length === 10 && sPhone === cPhone) {
    score += W_PHONE;
    signals.phone = true;
  }

  return { score: Math.min(100, score), signals };
}

export type BestMatch = {
  candidate: PbCandidate;
  score: number;
  signals: MatchSignals;
  /** True when score >= threshold AND the runner-up is clearly behind (no tie). */
  autoPostable: boolean;
  reason: string;
};

/** Pick the best PB candidate and decide if it clears the auto-post bar.
 *  Auto-post requires score >= 95 AND a clear lead over the 2nd-best (≥15) so
 *  two same-name/DOB people never silently collide. */
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
  const autoPostable = best.score >= threshold && clearLead;
  const sig = `name=${best.signals.name},dob=${best.signals.dob},email=${best.signals.email},phone=${best.signals.phone}`;
  const reason = autoPostable
    ? `auto-post: score ${best.score} (${sig}), lead +${best.score - runnerUp}`
    : `hold for review: score ${best.score} (${sig})${best.score >= threshold ? `, but runner-up too close (+${best.score - runnerUp})` : ""}`;
  return { candidate: best.candidate, score: best.score, signals: best.signals, autoPostable, reason };
}
