// Offline verification of the patient-identity scorer (no network).
// Run: npx tsx worker/scripts/test-iv-match.ts
import { scorePatientMatch, pickBestMatch, AUTO_POST_THRESHOLD } from "../src/iv/match-patient.js";

const SESSION = { fullName: "Blake Rosenberg", email: "blake@example.com", dob: "1990-05-14" };
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
}

// 1) exact name+dob+email → 100, single candidate auto-postable
{
  const c = { id: "p1", firstName: "Blake", lastName: "Rosenberg", emailAddress: "blake@example.com", dayOfBirth: "1990-05-14" };
  const s = scorePatientMatch(SESSION, c).score;
  const best = pickBestMatch(SESSION, [c]);
  check("exact all-3 → score 100", s === 100, `score=${s}`);
  check("exact all-3 → auto-postable", !!best?.autoPostable, best?.reason);
}
// 2) name+dob, no email → below threshold → hold
{
  const c = { id: "p2", firstName: "Blake", lastName: "Rosenberg", emailAddress: "other@x.com", dayOfBirth: "1990-05-14" };
  const best = pickBestMatch(SESSION, [c]);
  check("name+dob, wrong email → hold (<95)", best!.score < AUTO_POST_THRESHOLD && !best!.autoPostable, best?.reason);
}
// 3) name+email, no dob → hold
{
  const c = { id: "p3", firstName: "Blake", lastName: "Rosenberg", emailAddress: "blake@example.com", dayOfBirth: "1980-01-01" };
  const best = pickBestMatch(SESSION, [c]);
  check("name+email, wrong dob → hold", !best!.autoPostable, best?.reason);
}
// 4) two strong candidates (same name+dob) → no clear lead → hold even if ≥95
{
  const c1 = { id: "a", firstName: "Blake", lastName: "Rosenberg", emailAddress: "blake@example.com", dayOfBirth: "1990-05-14" };
  const c2 = { id: "b", firstName: "Blake", lastName: "Rosenberg", emailAddress: "blake@example.com", dayOfBirth: "1990-05-14" };
  const best = pickBestMatch(SESSION, [c1, c2]);
  check("two identical strong candidates → hold (tie)", best!.score >= 95 && !best!.autoPostable, best?.reason);
}
// 5) only last name → very low → hold
{
  const c = { id: "p5", firstName: "Zoe", lastName: "Rosenberg", emailAddress: "z@x.com", dayOfBirth: "1971-02-02" };
  const best = pickBestMatch(SESSION, [c]);
  check("last-name-only → hold", !best!.autoPostable && best!.score < 50, best?.reason);
}
// 6) best clearly leads (exact) over a weak other → auto-post
{
  const exact = { id: "good", firstName: "Blake", lastName: "Rosenberg", emailAddress: "blake@example.com", dayOfBirth: "1990-05-14" };
  const weak = { id: "weak", firstName: "Bob", lastName: "Rosenberg", emailAddress: "bob@x.com", dayOfBirth: "1960-01-01" };
  const best = pickBestMatch(SESSION, [exact, weak]);
  check("exact vs weak → auto-post the exact", best!.autoPostable && best!.candidate.id === "good", best?.reason);
}
// 7) no candidates → null
check("no candidates → null", pickBestMatch(SESSION, []) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
