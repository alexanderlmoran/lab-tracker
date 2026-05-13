import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { LAB_PORTALS, type LabPortal } from "@/lib/inbound/detect-notification";

export type LabPortalRow = {
  id: string;
  lab_key: string;
  label: string;
  url: string;
  audience: "patient" | "provider" | null;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// Multiple catalog names that should resolve to the same portal key.
// Mirrors the alias map in detect-notification.ts.
const PORTAL_ALIASES: Record<string, string> = {
  TruAge: "TruDiagnostic",
};

let cache: { rows: LabPortalRow[] | null; at: number } = { rows: null, at: 0 };
const TTL_MS = 30_000;

export function invalidateLabPortalsCache() {
  cache = { rows: null, at: 0 };
}

async function loadAllRows(): Promise<LabPortalRow[]> {
  const now = Date.now();
  if (cache.rows && now - cache.at < TTL_MS) return cache.rows;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_portals")
    .select("*")
    .order("lab_key", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as LabPortalRow[];
  cache = { rows, at: now };
  return rows;
}

export async function listLabPortalsFromDb(): Promise<LabPortalRow[]> {
  return loadAllRows();
}

export async function getAllPortalsForLab(
  labName: string | null | undefined,
): Promise<LabPortal[]> {
  if (!labName) return [];
  const resolved = PORTAL_ALIASES[labName] ?? labName;
  const rows = await loadAllRows();
  const dbMatches = rows.filter((r) => r.lab_key === resolved);
  if (dbMatches.length > 0) {
    return dbMatches.map((r) => ({
      key: r.lab_key,
      label: r.label,
      url: r.url,
      audience: r.audience ?? undefined,
    }));
  }
  // Fallback: when no DB rows exist for this lab, surface the code constant
  // so the UI still shows something on a fresh install.
  return LAB_PORTALS.filter((p) => p.key === resolved);
}
