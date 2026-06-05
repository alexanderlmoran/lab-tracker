import { getSupabaseAdmin } from "@/utils/supabase/admin";

// Same-accession duplicate cards = separate lab_cases rows that are the SAME
// physical lab order (e.g. a Zenoti-sync row + a bulk-import row), sharing the
// patient + accession but often with different tracking numbers. The kanban
// flags them with a "dup ×N" chip; the review actions cascade across the group
// so resolving one resolves all (they move together instead of orphaning).

/** All non-deleted, non-archived case ids that share `caseId`'s patient +
 *  accession (lab_external_ref) — i.e. its duplicate siblings. Includes
 *  `caseId` itself. Returns just [caseId] when the case has no accession or no
 *  siblings. Grouping mirrors the kanban dup chip exactly: patient key (email
 *  when present, else name) + TRIMMED lab_external_ref (accessions sometimes
 *  carry trailing whitespace, e.g. Access). */
export async function accessionSiblingIds(caseId: string): Promise<string[]> {
  const db = getSupabaseAdmin();
  const { data: c } = await db
    .from("lab_cases")
    .select("patient_email, patient_name, lab_external_ref")
    .eq("id", caseId)
    .maybeSingle();
  const ref = ((c?.lab_external_ref as string | null) ?? "").trim();
  if (!c || !ref) return [caseId];

  const email = ((c.patient_email as string | null) ?? "").trim();
  const name = ((c.patient_name as string | null) ?? "").trim();
  let q = db
    .from("lab_cases")
    .select("id, lab_external_ref")
    .is("deleted_at", null)
    .is("archived_at", null);
  q = email ? q.ilike("patient_email", email) : q.ilike("patient_name", name);
  const { data: rows } = await q;

  const ids = (rows ?? [])
    .filter((r) => ((r.lab_external_ref as string | null) ?? "").trim() === ref)
    .map((r) => r.id as string);
  return Array.from(new Set<string>([caseId, ...ids]));
}
