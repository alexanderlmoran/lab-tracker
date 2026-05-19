import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

export type PatientSeedRow = {
  id: string;
  patient_name: string;
  email: string;
  phone: string | null;
  dob: string | null;
  source: "manual" | "practicebetter" | "zenoti" | "csv_upload";
  notes: string | null;
};

/** Lightweight projection consumed by the import matcher + AI prompt. */
export type SeededPatient = {
  patientName: string;
  email: string;
  phone: string | null;
  dobIso: string | null;
};

/**
 * Pull every seeded patient. The list is bounded (operator-uploaded; tens of
 * thousands max), and the import path needs the full set to feed both the
 * ILIKE fallback and the AI's `known_patients` array. Sorted alphabetically
 * for stable hashing of the AI prompt — keeps prompt-cache hits warm.
 */
export async function listSeededPatients(): Promise<SeededPatient[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("patients_seed")
    .select("patient_name, email, phone, dob")
    .order("patient_name", { ascending: true });
  if (error) return [];
  return ((data ?? []) as Array<Pick<PatientSeedRow, "patient_name" | "email" | "phone" | "dob">>).map(
    (r) => ({
      patientName: r.patient_name,
      email: r.email,
      phone: r.phone,
      dobIso: r.dob,
    }),
  );
}

/**
 * Upsert by lowercased email — re-uploading the same source CSV updates
 * the row instead of duplicating. Empty emails are skipped (an email is
 * what makes a seed row useful for the import auto-fill).
 */
export async function upsertSeededPatients(
  rows: Array<{
    patientName: string;
    email: string;
    phone: string | null;
    dobIso: string | null;
    source: PatientSeedRow["source"];
    notes?: string | null;
  }>,
): Promise<{ inserted: number; failed: number; error?: string }> {
  if (rows.length === 0) return { inserted: 0, failed: 0 };
  const db = getSupabaseAdmin();
  // Dedupe by (email, name) within the batch. Supabase rejects an upsert
  // when the same conflict key appears more than once in one call ("cannot
  // affect row a second time"). Email alone is too coarse — Centner family
  // exports routinely share one address across multiple people; the unique
  // index is on (email, patient_name) so siblings each get their own row.
  const byKey = new Map<string, {
    patient_name: string;
    email: string;
    phone: string | null;
    dob: string | null;
    source: PatientSeedRow["source"];
    notes: string | null;
  }>();
  for (const r of rows) {
    const name = r.patientName.trim();
    const email = r.email.trim().toLowerCase();
    if (!email || !name) continue;
    const key = `${email}::${name.toLowerCase()}`;
    byKey.set(key, {
      patient_name: name,
      email,
      phone: r.phone,
      dob: r.dobIso,
      source: r.source,
      notes: r.notes ?? null,
    });
  }
  const cleaned = [...byKey.values()];
  if (cleaned.length === 0) return { inserted: 0, failed: rows.length };
  const { error, data } = await db
    .from("patients_seed")
    .upsert(cleaned, { onConflict: "email,patient_name" })
    .select("id");
  if (error) {
    return { inserted: 0, failed: cleaned.length, error: error.message };
  }
  return { inserted: data?.length ?? 0, failed: rows.length - cleaned.length };
}
