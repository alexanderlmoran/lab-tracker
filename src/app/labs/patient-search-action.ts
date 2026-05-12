"use server";

import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";

export type PatientSuggestion = {
  /** patient_email (lowercased) — the de facto patient identity in this app. */
  key: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** DOB as YYYY-MM-DD, surfaced if a prior case had one. */
  dobIso: string | null;
};

function sanitize(s: string): string {
  return s.replace(/[%_,()]/g, " ").trim();
}

/**
 * Typeahead source for the patient picker on /labs new-case form. Searches
 * existing patients across our own lab_cases table — name / email / phone.
 * Returns one row per distinct patient_email (most recent case wins for the
 * displayed name + phone + DOB).
 *
 * Previously this hit the PracticeBetter clients cache; PB was abandoned
 * 2026-05-11 so we now search our own data instead.
 */
export async function searchPatients(args: {
  query: string;
  limit?: number;
}): Promise<ActionResult<PatientSuggestion[]>> {
  await requireSignedIn();
  const term = sanitize(args.query ?? "");
  if (term.length < 2) return { ok: true, data: [] };

  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const db = getSupabaseAdmin();
  const pattern = `*${term}*`;

  const { data, error } = await db
    .from("lab_cases")
    .select("patient_name, patient_email, patient_phone, patient_dob, updated_at")
    .or(
      [
        `patient_name.ilike.${pattern}`,
        `patient_email.ilike.${pattern}`,
        `patient_phone.ilike.${pattern}`,
      ].join(","),
    )
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: error.message };

  // Dedupe by email, keeping the row with the most recent updated_at so the
  // suggestion reflects the patient's latest contact info on file.
  const byEmail = new Map<string, PatientSuggestion>();
  for (const r of (data ?? []) as Array<{
    patient_name: string;
    patient_email: string;
    patient_phone: string | null;
    patient_dob: string | null;
  }>) {
    const key = r.patient_email.toLowerCase();
    if (byEmail.has(key)) continue;
    byEmail.set(key, {
      key,
      name: r.patient_name,
      email: r.patient_email,
      phone: r.patient_phone,
      dobIso: r.patient_dob,
    });
    if (byEmail.size >= limit) break;
  }

  return { ok: true, data: [...byEmail.values()] };
}
