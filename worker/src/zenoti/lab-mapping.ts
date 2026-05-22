// Maps Zenoti service names → tracker lab_name values.
//
// Triggering rule (decided 2026-05-22 to support end-to-end test):
//   ANY service whose name starts with the case-insensitive prefix "Labs -"
//   triggers a tracker case. This guarantees that adding a new lab service
//   in Zenoti starts flowing into the tracker immediately, without a code
//   change required first.
//
// Lab name resolution cascade:
//   1. Explicit match in LAB_MAPPINGS (canonical names — preferred).
//   2. Fallback: strip the "Labs -" prefix and use the next whitespace-
//      separated token as the lab name (e.g. "Labs - Vibrant Custom" →
//      "Vibrant"). Captures unknown labs without dropping the appointment.
//
// Order in LAB_MAPPINGS matters when multiple rules could match — put more
// specific patterns first.

export type LabMapping = {
  match: string;
  labName: string;
};

// Canonical mappings derived from Centner's full Zenoti service list
// (Labs - List of All - Sheet1.csv, 2026-05-22). Order matters: more
// specific patterns must precede their parents. The token-split fallback
// (see resolveLabName) handles any future "Labs - *" service we forgot.
//
// Skip rules: services that aren't destination-lab work (Self Collection,
// Mobile Phlebotomy) and the placeholder "Labs" entry are filtered out
// before reaching this table via SKIP_PATTERNS below.
export const LAB_MAPPINGS: LabMapping[] = [
  // ── Access ────────────────────────────────────────────────────────
  { match: "Labs - Access", labName: "Access" },

  // ── Vibrant (many panels / zoomers / add-ons all route to one portal)
  { match: "Labs - EBOO Waste (Vibrant)", labName: "Vibrant" },
  { match: "Labs - Vibrant", labName: "Vibrant" },
  { match: "Labs - VIbrant", labName: "Vibrant" }, // typo in source CSV

  // ── Single-portal labs ────────────────────────────────────────────
  { match: "Labs - Cyrex", labName: "Cyrex" },
  { match: "Labs - Spectracell", labName: "Spectracell" },
  { match: "Labs - Genova", labName: "Genova" },
  { match: "Labs - Glycanage", labName: "GlycanAge" },
  { match: "Labs - Doctor's Data", labName: "DoctorsData" },
  { match: "Labs - RGCC", labName: "RGCC" },
  { match: "Labs - Life Length", labName: "LifeLength" },
  { match: "Labs - Kennedy Krieger", labName: "KennedyKrieger" },
  { match: "Labs - GOLDA", labName: "GOLDA" },

  // ── In-house / specialty (still create a case for tracking) ───────
  { match: "Labs - G6PD Deficiency", labName: "G6PD" },
  { match: "Labs - CancerCheck", labName: "CancerCheck" },
  { match: "Labs - Peptides", labName: "Peptides" },
  { match: "Labs - Members Panel", labName: "MembersPanel" },
];

/** Services that match the "Labs -" prefix but shouldn't create a case.
 * Logistics services (collection / phlebotomy / dispatch) aren't lab
 * destinations — they're how the sample gets to a destination lab. */
const SKIP_PATTERNS: string[] = [
  "Labs - Self Collection",
  "Labs - Mobile Phlebotomy",
];

/** Case-insensitive prefix that flags a service as lab-related. */
const LAB_PREFIX = "labs -";

/** Extract the lab name from a service that matches LAB_PREFIX but isn't in
 * LAB_MAPPINGS. Returns the first non-empty token after "Labs -", or null if
 * nothing useful remains (in which case the appointment is skipped). */
function fallbackLabName(servicename: string): string | null {
  const lower = servicename.toLowerCase();
  const idx = lower.indexOf(LAB_PREFIX);
  if (idx === -1) return null;
  const tail = servicename.slice(idx + LAB_PREFIX.length).trim();
  if (!tail) return null;
  const first = tail.split(/\s+/)[0];
  return first || null;
}

export function resolveLabName(servicename: string): string | null {
  if (!servicename) return null;
  const haystack = servicename.toLowerCase();

  // Generic "Labs" with no suffix is a placeholder service in Zenoti — skip.
  if (haystack.trim() === "labs") return null;

  for (const skip of SKIP_PATTERNS) {
    if (haystack.includes(skip.toLowerCase())) return null;
  }

  for (const m of LAB_MAPPINGS) {
    if (haystack.includes(m.match.toLowerCase())) return m.labName;
  }

  if (haystack.includes(LAB_PREFIX)) {
    return fallbackLabName(servicename);
  }

  return null;
}
