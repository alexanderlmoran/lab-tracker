// Pure helpers shared by the /labs page (server component) and the
// TimeRangeTabs client component. Kept out of `actions.ts` because that file
// is "use server" — every export there must be an async server action.

export type SinceKey = "all" | "24h" | "7d" | "30d" | "60d" | "90d";

export const SINCE_PRESETS: Array<{ key: SinceKey; label: string; days: number | null }> = [
  { key: "all", label: "All time", days: null },
  { key: "24h", label: "Last 24h", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "60d", label: "Last 60 days", days: 60 },
  { key: "90d", label: "Last 90 days", days: 90 },
];

export function sinceDaysForKey(key: string | undefined): number | null {
  const found = SINCE_PRESETS.find((p) => p.key === key);
  return found ? found.days : null;
}

export function parseSinceKey(value: string | undefined): SinceKey {
  if (
    value === "24h" ||
    value === "7d" ||
    value === "30d" ||
    value === "60d" ||
    value === "90d"
  ) {
    return value;
  }
  return "all";
}
