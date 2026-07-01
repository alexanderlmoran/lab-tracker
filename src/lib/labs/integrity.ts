// System-integrity audit — the single source of truth for "what's incomplete /
// unsafe" across active cases. Powers the Analytics → Integrity tab and the
// daily integrity alert. Zero rows in every bucket == the system is clean.
//
// Two buckets Alex is chasing to ZERO:
//   • DOB gaps      — an active case with no patient_dob (patient-safety: DOB is
//                     what disambiguates same-name PB charts before a post).
//   • Accession gaps— an active case that has SHIPPED (step 1) but has no
//                     lab_external_ref, so its result can't be matched back.
// Plus a collision check (same accession across DIFFERENT patients) — the
// wrong-patient hazard — which must always be empty.

import { getSupabaseAdmin } from "@/utils/supabase/admin";

/** Labs that don't carry a lab accession/requisition number, so a missing one
 *  isn't a gap. Peptides = a shipped product; the phlebotomy/collection service
 *  rows aren't lab orders. Matched case-insensitively by substring. */
const NO_ACCESSION_LABS = ["peptides", "mobile phlebotomy", "self collection", "self collection & dispatch"];

function labNeedsAccession(labName: string | null): boolean {
  const n = (labName ?? "").toLowerCase();
  return !NO_ACCESSION_LABS.some((x) => n.includes(x));
}

export type GapCase = {
  id: string;
  patientName: string;
  patientEmail: string;
  labName: string;
  labPanel: string | null;
};

export type IntegrityReport = {
  totalActive: number;
  dobGaps: GapCase[];
  accessionGaps: GapCase[];
  /** Same accession on two different patients — must be empty. */
  collisions: Array<{ accession: string; patients: string[] }>;
  /** Convenience: total actionable gaps (dob + accession). */
  gapCount: number;
};

export async function getIntegrityReport(): Promise<IntegrityReport> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, patient_email, patient_dob, lab_name, lab_panel, lab_external_ref, step1_sample_sent, step5_complete_uploaded",
    )
    .is("deleted_at", null)
    .is("archived_at", null);
  const rows = (data ?? []) as Array<{
    id: string;
    patient_name: string;
    patient_email: string;
    patient_dob: string | null;
    lab_name: string;
    lab_panel: string | null;
    lab_external_ref: string | null;
    step1_sample_sent: boolean;
    step5_complete_uploaded: boolean;
  }>;

  const toGap = (c: (typeof rows)[number]): GapCase => ({
    id: c.id,
    patientName: c.patient_name,
    patientEmail: c.patient_email,
    labName: c.lab_name,
    labPanel: c.lab_panel,
  });

  const dobGaps = rows.filter((c) => !c.patient_dob).map(toGap);

  // Accession is owed once the sample has SHIPPED (step 1) — before that it may
  // legitimately not exist yet. Skip labs that don't use accessions.
  const accessionGaps = rows
    .filter(
      (c) =>
        c.step1_sample_sent &&
        labNeedsAccession(c.lab_name) &&
        !(c.lab_external_ref ?? "").trim(),
    )
    .map(toGap);

  // Collision: one accession pointing at two different patients (danger).
  const byAcc = new Map<string, Set<string>>();
  for (const c of rows) {
    const a = (c.lab_external_ref ?? "").trim();
    if (!a) continue;
    (byAcc.get(a) ?? byAcc.set(a, new Set()).get(a)!).add(c.patient_name.toLowerCase());
  }
  const collisions = [...byAcc.entries()]
    .filter(([, pts]) => pts.size > 1)
    .map(([accession, pts]) => ({ accession, patients: [...pts] }));

  return {
    totalActive: rows.length,
    dobGaps,
    accessionGaps,
    collisions,
    gapCount: dobGaps.length + accessionGaps.length,
  };
}
