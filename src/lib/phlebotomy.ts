// Mobile-phlebotomy status model — the single source of truth for the
// appointment lifecycle, its board columns, the vendor list, and price/window
// formatting. Pure (no server imports) so the client board and the server
// actions share one definition. See supabase/migrations/20260630_phlebotomy_*.

// ── Lifecycle ────────────────────────────────────────────────────────────
// needs_scheduling → requested → scheduled → drawn → completed | canceled
export type PhlebStatus =
  | "needs_scheduling"
  | "requested"
  | "scheduled"
  | "drawn"
  | "completed"
  | "canceled";

// The five worklist lanes (canceled is NOT a lane — see getPhlebColumnFor).
export const PHLEB_COLUMN_ORDER = [
  "needs_scheduling",
  "requested",
  "scheduled",
  "drawn",
  "completed",
] as const;

export type PhlebColumnKey = (typeof PHLEB_COLUMN_ORDER)[number];

export const PHLEB_COLUMN_LABEL: Record<PhlebColumnKey, string> = {
  needs_scheduling: "Needs Scheduling",
  requested: "Requested",
  scheduled: "Scheduled",
  drawn: "Drawn",
  completed: "Completed",
};

export const PHLEB_STATUS_LABEL: Record<PhlebStatus, string> = {
  ...PHLEB_COLUMN_LABEL,
  canceled: "Canceled",
};

/**
 * Which board lane an appointment sits in. A canceled appointment folds back
 * into "Needs Scheduling" so the case stays visible for re-booking (the lane
 * shows a "canceled — reschedule" hint rather than hiding the work).
 */
export function getPhlebColumnFor(status: PhlebStatus): PhlebColumnKey {
  if (status === "canceled") return "needs_scheduling";
  return status;
}

// ── Vendors ──────────────────────────────────────────────────────────────
export type PhlebVendor = "draggo" | "speedy_sticks" | "other";

export const PHLEB_VENDORS: { key: PhlebVendor; label: string }[] = [
  { key: "draggo", label: "Draggo" },
  { key: "speedy_sticks", label: "Speedy Sticks" },
  { key: "other", label: "Other" },
];

const VENDOR_LABEL: Record<PhlebVendor, string> = {
  draggo: "Draggo",
  speedy_sticks: "Speedy Sticks",
  other: "Other",
};

/** Display name for a vendor; 'other' shows its free-text name when present. */
export function vendorLabel(
  vendor: string | null | undefined,
  vendorOther?: string | null,
): string {
  if (!vendor) return "—";
  if (vendor === "other") return vendorOther?.trim() || "Other";
  return VENDOR_LABEL[vendor as PhlebVendor] ?? vendor;
}

// ── Price (stored as integer cents) ────────────────────────────────────────
/** "$85.00" from cents, or "—" when unset. */
export function formatPrice(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Parse a "$85", "85.00", "85" string to integer cents, or null when blank/NaN. */
export function parsePriceToCents(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, "").trim();
  if (!cleaned) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

// ── Dates ──────────────────────────────────────────────────────────────────
/** "Jul 3, 10:00 AM" in clinic time (America/New_York); "" for null/invalid. */
export function formatApptDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
