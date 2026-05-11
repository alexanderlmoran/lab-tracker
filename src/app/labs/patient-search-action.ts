"use server";

import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";

export type PBClientSuggestion = {
  recordId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Phone, when present in the cached PB raw payload. */
  phone: string | null;
  /** DOB as ISO date string, when present in the cached PB raw payload. */
  dobIso: string | null;
};

type CachedRow = {
  record_id: string;
  first_name: string | null;
  last_name: string | null;
  email_lowered: string | null;
  raw: unknown;
};

/**
 * Strip characters that have special meaning in PostgREST `.or()` filter
 * strings (comma is the separator) and in ILIKE patterns (% and _).
 */
function sanitizeSearchTerm(s: string): string {
  return s.replace(/[%_,]/g, " ").trim();
}

/**
 * Phone/DOB live in `raw` (full PB JSON) — not promoted to dedicated columns
 * yet. Best-effort extraction; returns null when not present or shape is
 * unexpected.
 */
function pickFromRaw(raw: unknown): { phone: string | null; dobIso: string | null } {
  if (!raw || typeof raw !== "object") return { phone: null, dobIso: null };
  const r = raw as Record<string, unknown>;
  const profile = (r.profile ?? {}) as Record<string, unknown>;
  const client = (r.client ?? {}) as Record<string, unknown>;

  const phone =
    (typeof profile.phoneNumber === "string" && profile.phoneNumber) ||
    (typeof profile.cellPhone === "string" && profile.cellPhone) ||
    (typeof profile.homePhone === "string" && profile.homePhone) ||
    (typeof client.phoneNumber === "string" && client.phoneNumber) ||
    null;

  // PB returns DOB in formats like "1985-03-12T00:00:00" or "03/12/1985";
  // normalize to YYYY-MM-DD when possible, leave null otherwise.
  const rawDob =
    (typeof profile.dateOfBirth === "string" && profile.dateOfBirth) ||
    (typeof profile.dob === "string" && profile.dob) ||
    null;
  let dobIso: string | null = null;
  if (rawDob) {
    if (/^\d{4}-\d{2}-\d{2}/.test(rawDob)) {
      dobIso = rawDob.slice(0, 10);
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDob)) {
      const [m, d, y] = rawDob.split(" ")[0].split("/");
      dobIso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }

  return { phone: phone || null, dobIso };
}

/**
 * Search the cached PB client list by name or email substring. Used by the
 * patient typeahead in the case-create form and the CSV-import preview.
 *
 * Excludes child records (dependents) from results — the lab tracker keys
 * cases on the primary patient, not their children.
 */
export async function searchPBClients(args: {
  query: string;
  limit?: number;
}): Promise<ActionResult<PBClientSuggestion[]>> {
  await requireAdmin();
  const term = sanitizeSearchTerm(args.query ?? "");
  if (term.length < 2) return { ok: true, data: [] };

  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const db = getSupabaseAdmin();
  const pattern = `%${term}%`;

  const { data, error } = await db
    .from("practicebetter_clients")
    .select("record_id, first_name, last_name, email_lowered, raw")
    .eq("is_child_record", false)
    .or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},email_lowered.ilike.${pattern}`,
    )
    .order("last_name", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as CachedRow[];
  const suggestions: PBClientSuggestion[] = rows.map((r) => {
    const { phone, dobIso } = pickFromRaw(r.raw);
    return {
      recordId: r.record_id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email_lowered,
      phone,
      dobIso,
    };
  });

  return { ok: true, data: suggestions };
}
