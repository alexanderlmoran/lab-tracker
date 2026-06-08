"use server";

import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { resolveReqForm } from "@/lib/req-forms/resolve";
import { fillReqForm } from "@/lib/req-forms/fill";
import { specForLab } from "@/lib/req-forms/specs";
import type { ReqFormData } from "@/lib/req-forms/types";

/** Resolve a case's requisition-form values (DOB cascade etc.) for the edit dialog. */
export async function prepareReqForm(caseId: string) {
  await requireSignedIn();
  const r = await resolveReqForm(caseId);
  if (!r) return { ok: false as const, error: "No requisition template for this lab yet." };
  return {
    ok: true as const,
    label: r.spec.label,
    orderNumberMode: r.spec.orderNumber, // "manual" | "assign" | "accession"
    fields: r.data,
    missing: r.missing,
    editableKeys: r.editableKeys,
  };
}

/** Render the filled requisition PDF from the (staff-edited) fields. */
export async function generateReqForm(caseId: string, fields: ReqFormData) {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data: c } = await db.from("lab_cases").select("lab_name").eq("id", caseId).maybeSingle();
  const spec = specForLab((c?.lab_name as string | null) ?? null);
  if (!spec) return { ok: false as const, error: "No requisition template for this lab yet." };

  const fill: ReqFormData = { ...fields };
  // Forms with Male/Female checkboxes get an X; Kennedy uses the plain `sex` text.
  if (fields.sex) {
    fill.sexMaleX = /^m/i.test(fields.sex) ? "X" : "";
    fill.sexFemaleX = /^f/i.test(fields.sex) ? "X" : "";
  }
  const bytes = await fillReqForm(spec, fill);
  return {
    ok: true as const,
    pdfBase64: Buffer.from(bytes).toString("base64"),
    filename: `${spec.label.split(" ")[0]}-req-${caseId.slice(0, 8)}.pdf`,
  };
}
