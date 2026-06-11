// Shared display-formatting helpers. Centralized so card components don't
// drift on capitalization and label conventions. None of these touch the
// database; they only normalize whatever comes back for the screen.

import type { AppRole } from "@/lib/auth-guard";

// The clinic operates on Eastern time, but the code runs in two timezones:
// Vercel/Fly servers are UTC, staff browsers are America/New_York. Any
// "what calendar day is it" computed with the HOST's timezone disagrees
// between SSR and the client for ~4-5h every evening (hydration mismatches,
// off-by-one date windows). This formatter answers in EASTERN regardless of
// where it runs — use it for every today/date-only comparison.
const EASTERN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD for the given instant (default: now) in the clinic's timezone. */
export function easternDateIso(d: Date = new Date()): string {
  return EASTERN_DAY.format(d);
}

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
