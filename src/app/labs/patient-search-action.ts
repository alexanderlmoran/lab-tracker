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
  /** True when this suggestion is only in patients_seed (never had a case).
   * UI uses it to show a "no prior labs" hint so the operator knows it's a
   * first-time order rather than a returning patient. */
  seededOnly?: boolean;
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
  const ilikePattern = `%${term}%`;

  // Query lab_cases AND patients_seed in parallel. lab_cases is the
  // source of truth for active patients (has phone/DOB updated by staff);
  // the seed fills the gap for first-time orders where the patient exists
  // in PB/Zenoti but hasn't yet had a lab in our system.
  const [casesRes, seedRes] = await Promise.all([
    db
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
      .limit(50),
    db
      .from("patients_seed")
      .select("patient_name, email, phone, dob")
      .or(`patient_name.ilike.${ilikePattern},email.ilike.${ilikePattern}`)
      .limit(50),
  ]);
  if (casesRes.error && seedRes.error) {
    return { ok: false, error: casesRes.error.message };
  }

  // Dedupe by email. Cases win over seed because they carry the freshest
  // contact info (staff edits land on the case row, not the seed row).
  const byEmail = new Map<string, PatientSuggestion>();
  for (const r of (casesRes.data ?? []) as Array<{
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

  if (byEmail.size < limit) {
    for (const r of (seedRes.data ?? []) as Array<{
      patient_name: string;
      email: string;
      phone: string | null;
      dob: string | null;
    }>) {
      const key = r.email.toLowerCase();
      if (byEmail.has(key)) continue;
      byEmail.set(key, {
        key,
        name: r.patient_name,
        email: r.email,
        phone: r.phone,
        dobIso: r.dob,
        seededOnly: true,
      });
      if (byEmail.size >= limit) break;
    }
  }

  return { ok: true, data: [...byEmail.values()] };
}
