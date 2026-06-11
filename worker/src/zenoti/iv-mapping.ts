// Maps Zenoti "IV -" service names → PB session-note template + charting behavior.
//
// Sibling of lab-mapping.ts. Built 2026-06-09 from the appointments CSV taxonomy
// (517 IVs, 31 distinct services) plus the PB session-note template naming
// convention observed live in PracticeBetter ("IV - Immune Boost (updated)",
// "Infusion #29 (#20+2 Vials) - Phosphatidylcholine Infusion", etc.).
//
// WHY THIS EXISTS: PB notes were going missing / mis-templated specifically for
// Custom, PC, and add-on services. This module is the single source of truth for
// classifying an IV service so the charting layer knows:
//   - kind:     standard | addon | pc | custom | ebo  (drives note behavior)
//   - isAddOn:  add-ons APPEND to that visit's base IV note, not a standalone note
//   - weber:    note carries a Weber laser section
//   - templateHint: the canonical string to fuzzy-match against the live PB
//                   sessionnotetemplates catalog at post time. We deliberately do
//                   NOT hard-code PB template names here (they drift / carry
//                   "(updated)" suffixes); the hint defaults to the cleaned
//                   service name and is reconciled against the real catalog
//                   server-side, mirroring how resolveLabName stays loose.
//
// Matching philosophy (same as lab-mapping): a small OVERRIDE table for the
// special cases, then a sensible fallback derived from the service name. Adding a
// new "IV - *" service in Zenoti therefore flows through immediately, classified
// as a plain standard infusion, without a code change required first.

export type IvKind = "standard" | "addon" | "pc" | "custom" | "ebo";

export type IvServiceInfo = {
  /** The raw Zenoti service name, untouched. */
  serviceName: string;
  kind: IvKind;
  /** Add-ons (Glutathione Push, Vit D3, B12) attach to the visit's base IV note
   *  rather than creating their own note. */
  isAddOn: boolean;
  /** Note includes a Weber laser section (e.g. "IV - Weber", "IV - Chelation + Weber"). */
  weber: boolean;
  /** Canonical string to fuzzy-match against the live PB template catalog. */
  templateHint: string;
};

/** Case-insensitive prefix that flags a service as an IV. Note the source data
 *  contains a double-space variant ("IV -  STAFF Myers' Cocktail"), so we match
 *  on the "iv -" prefix and trim the remainder rather than requiring one space. */
const IV_PREFIX = "iv -";

export function isIvService(serviceName: string | null | undefined): boolean {
  if (!serviceName) return false;
  return serviceName.trim().toLowerCase().startsWith(IV_PREFIX);
}

/** The service name with the "IV -" prefix removed and whitespace collapsed. */
function ivRemainder(serviceName: string): string {
  const lower = serviceName.toLowerCase();
  const idx = lower.indexOf(IV_PREFIX);
  const tail = idx === -1 ? serviceName : serviceName.slice(idx + IV_PREFIX.length);
  return tail.replace(/\s+/g, " ").trim();
}

const ADDON_RE = /\badd[\s-]?on\b/i;
const WEBER_RE = /\bweber\b/i;
const EBO_RE = /\bebo(o|2)?\b|oxygenation|ozone/i;
// "PC", "PC SP", "PC15 SP" — phosphatidylcholine. Anchored so it can't match a
// stray "pc" inside another word.
const PC_RE = /^pc(15)?(\s+sp)?$/i;
const CUSTOM_RE = /^custom\b/i;

/**
 * Explicit template-hint overrides for services whose PB template name differs
 * from the cleaned service name. Keep this SMALL — only real, observed mismatches.
 * Matched as a case-insensitive substring of the remainder (after "IV -").
 */
const TEMPLATE_HINT_OVERRIDES: Array<{ match: RegExp; hint: string }> = [
  // Phosphatidylcholine notes are titled "Infusion #N (#X Vials) - Phosphatidylcholine
  // Infusion" in PB — the #N + vial count are filled per session (from Zenoti
  // consumables or entered in the charting form), not part of the template name.
  { match: PC_RE, hint: "Phosphatidylcholine Infusion" },
];

/**
 * Classify an "IV -" service. Returns null for non-IV services so callers can
 * filter the same way fetchZenotiLabAppointments filters on resolveLabName.
 */
export function classifyIvService(
  serviceName: string | null | undefined,
): IvServiceInfo | null {
  if (!isIvService(serviceName)) return null;
  const name = serviceName as string;
  const remainder = ivRemainder(name);

  const isAddOn = ADDON_RE.test(name);
  const weber = WEBER_RE.test(remainder);

  let kind: IvKind;
  if (isAddOn) kind = "addon";
  else if (EBO_RE.test(remainder)) kind = "ebo";
  else if (PC_RE.test(remainder)) kind = "pc";
  else if (CUSTOM_RE.test(remainder)) kind = "custom";
  else kind = "standard";

  // templateHint: start from the cleaned remainder, drop the "(Add-on)" marker
  // (and any leading "STAFF" qualifier), then apply explicit overrides.
  let templateHint = remainder
    .replace(/\((?:add[\s-]?on)\)/gi, "")
    .replace(/\badd[\s-]?on\b/gi, "")
    .replace(/^\s*staff\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const o of TEMPLATE_HINT_OVERRIDES) {
    if (o.match.test(remainder)) {
      templateHint = o.hint;
      break;
    }
  }

  return { serviceName: name, kind, isAddOn, weber, templateHint };
}
