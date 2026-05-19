// Shared display-formatting helpers. Centralized so card components don't
// drift on capitalization and label conventions. None of these touch the
// database; they only normalize whatever comes back for the screen.

import type { AppRole } from "@/lib/auth-guard";

const NAME_PARTICLES = new Set([
  "de",
  "del",
  "della",
  "di",
  "da",
  "der",
  "den",
  "la",
  "le",
  "van",
  "von",
  "y",
]);

const ROMAN_NUMERAL = /^(II|III|IV|V|VI|VII|VIII|IX|XI|XII)$/i;

function titleCaseToken(token: string): string {
  if (!token) return token;
  // Roman numerals (case-insensitive match) render upper-case regardless of
  // input casing — "viii" / "VIII" / "Viii" all become "VIII".
  if (ROMAN_NUMERAL.test(token)) return token.toUpperCase();
  // Hyphenated piece: title-case each side. "smith-jones" → "Smith-Jones".
  if (token.includes("-")) {
    return token.split("-").map(titleCaseToken).join("-");
  }
  // Lower-case everything, then upper-case the first letter and any letter
  // immediately following an apostrophe (O'Brien, D'Angelo).
  const lower = token.toLowerCase();
  const firstCapped = lower.charAt(0).toUpperCase() + lower.slice(1);
  return firstCapped.replace(/(['’])(\p{L})/gu, (_match, apostrophe: string, letter: string) =>
    apostrophe + letter.toUpperCase(),
  );
}

/**
 * Title-case a person name imported from a CSV (often ALL CAPS, sometimes
 * all lowercase, occasionally mixed). Preserves apostrophe / hyphen
 * conventions and lower-cases European particles like "van" or "de".
 *
 *   "JOHN SMITH"        → "John Smith"
 *   "john o'brien"      → "John O'Brien"
 *   "MARIA DE LA CRUZ"  → "Maria de la Cruz"
 *   "smith-jones"       → "Smith-Jones"
 */
export function formatPersonName(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const tokens = trimmed.split(" ");
  return tokens
    .map((tok, i) => {
      const lower = tok.toLowerCase();
      // Keep European particles lowercase, but never as the first token.
      if (i > 0 && NAME_PARTICLES.has(lower)) return lower;
      return titleCaseToken(tok);
    })
    .join(" ");
}

/**
 * Format a YYYY-MM-DD ISO date as a short human label ("May 18"). Returns
 * the input unchanged if it doesn't parse — never NaN/Invalid Date in UI.
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Friendly labels for the AppRole enum. Used wherever the role is shown
 * to the user (account dropdowns, badges, confirmation text). */
export const ROLE_LABEL: Record<AppRole, string> = {
  developer: "Developer",
  admin: "Admin",
  staff: "Staff",
};
