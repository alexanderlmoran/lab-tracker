"use server";

import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { resolveReqForm, reqFormCustomDefaults, reqFormCustomSelects } from "@/lib/req-forms/resolve";
import { fillReqForm } from "@/lib/req-forms/fill";
import { specForLab, REQ_FORM_SPECS } from "@/lib/req-forms/specs";
import { loadOverrides, saveOverrides, mergeFields, type FieldOverrides, type CustomField } from "@/lib/req-forms/overrides";
import { expandStampFields } from "@/lib/req-forms/derive";
import type { ReqFormData, ReqField, ReqFormSpec } from "@/lib/req-forms/types";

const BUCKET = "req-form-templates";

// Representative text so even still-empty fields are draggable in the calibrator.
const SAMPLE: Partial<Record<ReqField, string>> = {
  patientName: "Patient Name", firstName: "First", lastName: "Last", mi: "A",
  dob: "01/15/1980", sex: "M", collectionDate: "06/08/2026", orderDate: "06/08/2026", orderNumber: "0000",
  collectionMonth: "06", collectionDay: "08", collectionYear: "2026", collectionTime: "8:30",
  dobMonth: "04", dobDay: "10", dobYear: "1979",
};
function calibText(field: ReqField, data: ReqFormData): string {
  if (field.endsWith("X")) return "X"; // every checkbox field (sex/fasting/AM-PM/redraw) shows an X to place
  return data[field] || SAMPLE[field] || field;
}

/** Resolve a case's requisition-form values (DOB cascade etc.) for the edit dialog. */
export async function prepareReqForm(caseId: string) {
  await requireSignedIn();
  const r = await resolveReqForm(caseId);
  if (!r) return { ok: false as const, error: "No requisition template for this lab yet." };
  const ov = await loadOverrides(r.spec.templateKey);
  const defaults = reqFormCustomDefaults(r.spec.templateKey, { orderDate: r.data.orderDate });
  const selects = reqFormCustomSelects(r.spec.templateKey);
  return {
    ok: true as const,
    label: r.spec.label,
    orderNumberMode: r.spec.orderNumber, // "manual" | "assign" | "accession"
    fields: r.data,
    missing: r.missing,
    editableKeys: r.editableKeys,
    // Only the genuinely per-case custom fields. Anything reqFormCustomDefaults
    // manages (facility / billing / credit-card / fixed checkboxes / derived
    // dates) is stamped automatically and HIDDEN here, so the dialog stays as
    // lean as the KK/SpectraCell forms. A field with options renders a dropdown.
    custom: ov.custom
      .filter((c) => !(c.label in defaults))
      .map((c) => ({ key: c.key, label: c.label, value: "", options: selects[c.label] ?? null })),
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
export async function generateReqForm(
  caseId: string,
  fields: ReqFormData,
  customValues: Record<string, string> = {},
) {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data: c } = await db
    .from("lab_cases")
    .select("lab_name, patient_name, patient_dob, lab_external_ref")
    .eq("id", caseId)
    .maybeSingle();
  const spec = specForLab((c?.lab_name as string | null) ?? null);
  if (!spec) return { ok: false as const, error: "No requisition template for this lab yet." };

  // Two-way: persist the entered DOB to the tracker (and the patient's other
  // cases that lack one — don't clobber a different existing value).
  const dobIso = dobToIso(fields.dob);
  if (dobIso && dobIso !== (c?.patient_dob as string | null)) {
    // CHECK the DOB write (mirror the sex write below, which already does) — it was
    // unchecked, so a failed save silently dropped a DOB the staff believed was
    // stored for next time. Only run the cascade + event when the primary landed.
    const { error: dobErr } = await db.from("lab_cases").update({ patient_dob: dobIso }).eq("id", caseId);
    if (dobErr) {
      console.error(`[req-form] DOB write failed for case ${caseId}: ${dobErr.message}`);
    } else {
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
  }

  // Same two-way persistence for sex (M/F) — enter it once, prefilled forever.
  // Normalized to M/F; tolerant of patient_sex not being migrated yet.
  const sexNorm = fields.sex ? (/^m/i.test(fields.sex) ? "M" : /^f/i.test(fields.sex) ? "F" : "") : "";
  if (sexNorm) {
    const { error: sexErr } = await db.from("lab_cases").update({ patient_sex: sexNorm }).eq("id", caseId);
    if (!sexErr) {
      const name = c?.patient_name as string | undefined;
      if (name) {
        await db.from("lab_cases").update({ patient_sex: sexNorm }).eq("patient_name", name).is("patient_sex", null);
      }
      await db.from("lab_events").insert({
        case_id: caseId,
        kind: "case_edited" as const,
        actor: user.email ?? "staff",
        note: `Sex set to ${sexNorm} via req form (propagated to this patient's other cases)`,
      });
    }
  }

  // Persist a manually-entered order / Sample # (Kennedy) back to the case's
  // accession so it shows on the patient's lab card. Guarded to "manual" mode +
  // no existing ref so a scraped/assigned accession (SpectraCell/DoctorsData) is
  // never clobbered. Per-kit, so NOT propagated to the patient's other cases.
  const enteredRef = (fields.orderNumber ?? "").trim();
  if (spec.orderNumber === "manual" && enteredRef && !((c?.lab_external_ref as string | null)?.trim())) {
    const { error: refErr } = await db
      .from("lab_cases")
      .update({ lab_external_ref: enteredRef })
      .eq("id", caseId);
    if (refErr) {
      console.error(`[req-form] order# write failed for case ${caseId}: ${refErr.message}`);
    } else {
      await db.from("lab_events").insert({
        case_id: caseId,
        kind: "case_edited" as const,
        actor: user.email ?? "staff",
        note: `Accession / Sample # set to ${enteredRef} via req form`,
      });
    }
  }

  // Expand into checkbox X's + split MM/DD/YYYY date segments (re-derived from
  // the staff-edited dob/collectionDate so they always match the typed values).
  const fill = expandStampFields(fields);
  // Merge constant defaults UNDER the staff-entered values, matched by the custom
  // field's label — so clinic constants (FacilityName/NPI/etc.) always stamp even
  // if the client didn't send them, while a staff override still wins.
  const ov = await loadOverrides(spec.templateKey);
  const defaults = reqFormCustomDefaults(spec.templateKey, { orderDate: fields.orderDate });
  const mergedCustom: Record<string, string> = {};
  for (const c of ov.custom) {
    const v = (customValues[c.key] ?? "").trim() || defaults[c.label] || "";
    if (v) mergedCustom[c.key] = v;
  }
  const bytes = await fillReqForm(spec, fill, mergedCustom);
  return {
    ok: true as const,
    pdfBase64: Buffer.from(bytes).toString("base64"),
    filename: `${spec.label.split(" ")[0]}-req-${caseId.slice(0, 8)}.pdf`,
  };
}

/** The req-form templates available to calibrate, for the Settings picker. */
export async function listReqFormTemplates() {
  await requireSignedIn();
  return {
    ok: true as const,
    templates: REQ_FORM_SPECS.map((s) => ({ templateKey: s.templateKey, label: s.label })),
  };
}

/** Shared body of the calibrator load: given a resolved spec (+ optional real
 *  case values), fetch the blank template and build the draggable item list.
 *  `data` is the case's resolved values when calibrating from a card, or empty
 *  in the Settings flow — calibText falls back to SAMPLE text either way. */
async function buildCalibration(
  spec: ReqFormSpec,
  data: ReqFormData,
) {
  const db = getSupabaseAdmin();
  const { data: file, error } = await db.storage.from(BUCKET).download(spec.templateKey);
  if (error || !file) {
    return { ok: false as const, error: `Template "${spec.templateKey}" not found: ${error?.message ?? "missing"}` };
  }
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const ov = await loadOverrides(spec.templateKey);
  const fields = mergeFields(spec.fields, ov.fields);

  // Draggable items: every positioned spec field (sample text) + every custom
  // field the user added (shown by its label). The calibrator stamps these as
  // SVG text over the rendered page.
  const items = [
    ...Object.entries(fields).map(([field, pos]) => ({
      field: field as string,
      text: calibText(field as ReqField, data),
      x: pos!.x,
      yTop: pos!.yTop,
      size: pos!.size ?? 26,
      page: pos!.page ?? 0,
      custom: false,
      label: "",
    })),
    ...ov.custom.map((c) => ({
      field: c.key,
      text: c.label,
      x: c.x,
      yTop: c.yTop,
      size: c.size,
      page: c.page ?? 0,
      custom: true,
      label: c.label,
    })),
  ];

  return {
    ok: true as const,
    label: spec.label,
    templateKey: spec.templateKey,
    templateBase64: base64,
    fields: ov.fields, // saved position overrides, preserved on next save
    items,
  };
}

/** Load everything the visual calibrator needs: the blank template bytes (to
 *  render in-browser) plus each positioned field's current coords + sample text.
 *  Coords are the spec merged with any saved overrides — so calibration resumes
 *  from where it was left, not from the original spec. Pass a `caseId` to
 *  preview with the case's real values (from a card), or a `templateKey` to
 *  calibrate any template from Settings with no case attached. */
export async function loadReqFormCalibration(
  arg: { caseId: string } | { templateKey: string },
) {
  await requireSignedIn();
  if ("templateKey" in arg) {
    const spec = REQ_FORM_SPECS.find((s) => s.templateKey === arg.templateKey);
    if (!spec) return { ok: false as const, error: `Unknown template "${arg.templateKey}".` };
    return buildCalibration(spec, {});
  }
  const r = await resolveReqForm(arg.caseId);
  if (!r) return { ok: false as const, error: "No requisition template for this lab yet." };
  return buildCalibration(r.spec, r.data);
}

/** Persist calibrated positions + custom fields for a template (validated against
 *  known specs). Lives instantly: fillReqForm merges these over the spec next render. */
export async function saveReqFormPositions(
  templateKey: string,
  fields: FieldOverrides,
  custom: CustomField[] = [],
) {
  await requireSignedIn();
  if (!REQ_FORM_SPECS.some((s) => s.templateKey === templateKey)) {
    return { ok: false as const, error: `Unknown template "${templateKey}".` };
  }
  await saveOverrides(templateKey, { fields, custom });
  return { ok: true as const };
}
