"use server";

import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { resolveReqForm } from "@/lib/req-forms/resolve";
import { fillReqForm } from "@/lib/req-forms/fill";
import { specForLab, REQ_FORM_SPECS } from "@/lib/req-forms/specs";
import { loadOverrides, saveOverrides, mergeFields, type FieldOverrides } from "@/lib/req-forms/overrides";
import type { ReqFormData, ReqField } from "@/lib/req-forms/types";

const BUCKET = "req-form-templates";

// Representative text so even still-empty fields are draggable in the calibrator.
const SAMPLE: Partial<Record<ReqField, string>> = {
  patientName: "Patient Name", firstName: "First", lastName: "Last", mi: "A",
  dob: "01/15/1980", sex: "M", collectionDate: "06/08/2026", orderDate: "06/08/2026", orderNumber: "0000",
};
function calibText(field: ReqField, data: ReqFormData): string {
  if (field === "sexMaleX" || field === "sexFemaleX" || field === "fastingX") return "X";
  return data[field] || SAMPLE[field] || field;
}

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

/** MM/DD/YYYY → ISO YYYY-MM-DD, or null if not a full valid date. */
function dobToIso(s: string | undefined): string | null {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Render the filled requisition PDF from the (staff-edited) fields, AND persist
 *  the entered DOB back to the tracker so it's never re-typed (propagates to the
 *  patient's other DOB-less cases too). Zenoti/PB write-back is a follow-up. */
export async function generateReqForm(caseId: string, fields: ReqFormData) {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data: c } = await db
    .from("lab_cases")
    .select("lab_name, patient_name, patient_dob")
    .eq("id", caseId)
    .maybeSingle();
  const spec = specForLab((c?.lab_name as string | null) ?? null);
  if (!spec) return { ok: false as const, error: "No requisition template for this lab yet." };

  // Two-way: persist the entered DOB to the tracker (and the patient's other
  // cases that lack one — don't clobber a different existing value).
  const dobIso = dobToIso(fields.dob);
  if (dobIso && dobIso !== (c?.patient_dob as string | null)) {
    await db.from("lab_cases").update({ patient_dob: dobIso }).eq("id", caseId);
    const name = c?.patient_name as string | undefined;
    if (name) {
      await db.from("lab_cases").update({ patient_dob: dobIso }).eq("patient_name", name).is("patient_dob", null);
    }
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "case_edited" as const,
      actor: user.email ?? "staff",
      note: `DOB set to ${fields.dob} via req form (propagated to this patient's DOB-less cases)`,
    });
  }

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

/** Load everything the visual calibrator needs: the blank template bytes (to
 *  render in-browser) plus each positioned field's current coords + sample text.
 *  Coords are the spec merged with any saved overrides — so calibration resumes
 *  from where it was left, not from the original spec. */
export async function loadReqFormCalibration(caseId: string) {
  await requireSignedIn();
  const r = await resolveReqForm(caseId);
  if (!r) return { ok: false as const, error: "No requisition template for this lab yet." };

  const db = getSupabaseAdmin();
  const { data: file, error } = await db.storage.from(BUCKET).download(r.spec.templateKey);
  if (error || !file) {
    return { ok: false as const, error: `Template "${r.spec.templateKey}" not found: ${error?.message ?? "missing"}` };
  }
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const fields = mergeFields(r.spec.fields, await loadOverrides(r.spec.templateKey));

  // [field, pos, sample-text] for every positioned field — the calibrator stamps
  // these as draggable SVG text over the rendered page.
  const items = Object.entries(fields).map(([field, pos]) => ({
    field: field as ReqField,
    text: calibText(field as ReqField, r.data),
    x: pos!.x,
    yTop: pos!.yTop,
    size: pos!.size ?? 26,
    page: pos!.page ?? 0,
  }));

  return {
    ok: true as const,
    label: r.spec.label,
    templateKey: r.spec.templateKey,
    templateBase64: base64,
    fields, // full map, preserved on save (page / maxChars etc.)
    items,
  };
}

/** Persist calibrated positions for a template (validated against known specs).
 *  Lives instantly: fillReqForm merges these over the spec on the next render. */
export async function saveReqFormPositions(templateKey: string, fields: FieldOverrides) {
  await requireSignedIn();
  if (!REQ_FORM_SPECS.some((s) => s.templateKey === templateKey)) {
    return { ok: false as const, error: `Unknown template "${templateKey}".` };
  }
  await saveOverrides(templateKey, fields);
  return { ok: true as const };
}
