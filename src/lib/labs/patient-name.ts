// Patient-identity comparison — the single source of truth for the
// "does this report belong to this case's patient?" gate.
//
// Pure string functions only (NO server-only imports) so this is isomorphic:
// the server uses it in result-ready + the pb-upload claim guard; the client
// uses it in the Approve / Pending-Upload review banner. One change here
// propagates everywhere a name is compared.

/**
 * Loose last-name key for the patient-identity gate:
 *   "PADGETT, NICOLE" / "Marc Nicole Padgett" / "nicole padgett" → "padgett".
 * Lenient on purpose — first-name spelling variance (Bob/Robert, accents,
 * middle names) must NOT block a real result. We compare ONLY the surname,
 * which is the part that distinguishes one patient's report from another's.
 */
export function lastNameKey(s: string | null | undefined): string {
  const clean = (s ?? "").replace(/[^a-zA-Z, ]/g, " ").trim().toLowerCase();
  if (!clean) return "";
  if (clean.includes(",")) {
    // "Last, First" → take the part before the comma, then its last token.
    return clean.split(",")[0]!.trim().split(/\s+/).pop() ?? "";
  }
  const parts = clean.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/**
 * True when both names resolve to a last-name key AND those keys differ —
 * i.e. a CONFIDENT mismatch (this report is for a different patient). Returns
 * false when either side is blank/unknowable, so a missing name never blocks
 * (the fail-closed accession tie in result-ready handles the "no name" case).
 */
export function isLastNameMismatch(
  reportName: string | null | undefined,
  caseName: string | null | undefined,
): boolean {
  const a = lastNameKey(reportName);
  const b = lastNameKey(caseName);
  return Boolean(a && b && a !== b);
}
