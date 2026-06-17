// Resolve the per-patient values for a case's requisition form. DOB cascade
// (the field Alex cares most about): case.patient_dob → patients_seed cache
// (populated from PB + Zenoti) → blank for staff. Same fallback for phone/email.
// A live PB lookup isn't possible from Vercel (PB IP-blocks it), but the seed
// cache already holds the PB/Zenoti DOBs, so we read those.

import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { formatPersonName } from "@/lib/format";
import { specForLab } from "./specs";
import { expandStampFields } from "./derive";
import type { ReqFormData, ReqFormSpec } from "./types";

function splitName(full: string): { first: string; last: string; mi: string } {
  const s = (full ?? "").replace(/\s+/g, " ").trim();
  if (s.includes(",")) {
    const [last, rest] = s.split(",");
    const parts = (rest ?? "").trim().split(" ").filter(Boolean);
    return { last: last.trim(), first: parts[0] ?? "", mi: parts.length > 1 ? (parts[1][0] ?? "") : "" };
  }
  const parts = s.split(" ").filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "", mi: "" };
  return {
    first: parts[0],
    last: parts[parts.length - 1],
    mi: parts.length > 2 ? (parts[1][0] ?? "") : "",
  };
}

function fmtDate(iso: string | null | undefined, sep = "/"): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}${sep}${m[3]}${sep}${m[1]}` : iso;
}

function parseAddress(addr: string | null): { address: string; city: string; state: string; zip: string } {
  if (!addr) return { address: "", city: "", state: "", zip: "" };
  // best-effort "street, city, ST 12345"
  const m = addr.match(/^(.*?),\s*([^,]+?),?\s*([A-Za-z]{2})\.?\s*(\d{5})?/);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] ?? "" };
  return { address: addr.trim(), city: "", state: "", zip: "" };
}

export type ResolvedReqForm = {
  spec: ReqFormSpec;
  data: ReqFormData;
  missing: string[]; // fields we couldn't resolve — surfaced for staff to complete
  editableKeys: string[]; // only the variable fields the dialog should show
};

// Fixed on every Centner req (Alex): patient address = the clinic (same as the
// FedEx pickup), clinic phone, labs@ email, fasting always Yes.
const CLINIC = {
  address: "2333 Brickell Ave Ste A1",
  city: "Miami",
  state: "FL",
  zip: "33129",
  phone: "305-602-5260",
  email: "labs@centnerhb.com",
};

/** Constant auto-fills for a template's CUSTOM calibrator fields, matched by the
 *  field's LABEL (the calibrator stores user-added fields by label). Clinic/provider
 *  constants so staff never re-type them each print. Patient-specific, payment, and
 *  signature-date fields are intentionally omitted — they stay blank for staff.
 *  Returns {} for templates with no constants. */
export function reqFormCustomDefaults(templateKey: string): Record<string, string> {
  if (templateKey === "mitoswab.pdf") {
    return {
      NewSample: "X", // default to a new (not replacement) sample
      ReportEmail: "X", // provider preferred reporting = Email
      FacilityName: process.env.PRACTICE_NAME || "Centner Wellness",
      Telephone: CLINIC.phone,
      FacilityEmail: CLINIC.email,
      AddressStreet: CLINIC.address,
      AddressCity: CLINIC.city,
      AddressState: CLINIC.state,
      AddressZipCode: CLINIC.zip,
      AddressCountry: "USA",
      Country: "USA", // patient block routes to the clinic
      ProviderNPI: "1124065693",
      PhysicianTitle: "MD",
    };
  }
  return {};
}

export async function resolveReqForm(
  caseId: string,
  opts: { orderNumber?: string } = {},
): Promise<ResolvedReqForm | null> {
  const db = getSupabaseAdmin();
  const { data: c } = await db
    .from("lab_cases")
    .select(
      "patient_name, patient_dob, patient_email, patient_phone, patient_address, collection_date, lab_name, lab_external_ref, tracking_number",
    )
    .eq("id", caseId)
    .maybeSingle();
  if (!c) return null;
  const spec = specForLab(c.lab_name as string | null);
  if (!spec) return null;

  let dob = (c.patient_dob as string | null) ?? null;
  let email = (c.patient_email as string | null) ?? null;
  let phone = (c.patient_phone as string | null) ?? null;
  if (!dob || !email || !phone) {
    const { data: seed } = await db
      .from("patients_seed")
      .select("dob, email, phone")
      .ilike("patient_name", (c.patient_name as string).trim())
      .limit(1);
    const s = seed?.[0] as { dob: string | null; email: string | null; phone: string | null } | undefined;
    if (s) {
      dob = dob || s.dob;
      email = email || s.email;
      phone = phone || s.phone;
    }
  }

  // Title-case the name (stored values are often ALL-CAPS or lowercase) so the
  // stamped form matches how the name reads everywhere else in the app.
  const fullName = formatPersonName(c.patient_name as string);
  const { first, last, mi } = splitName(fullName);
  // Prefill sex from a prior entry (persisted by generateReqForm). Separate query
  // so a not-yet-migrated patient_sex column degrades to blank, never an error.
  const { data: sx } = await db.from("lab_cases").select("patient_sex").eq("id", caseId).maybeSingle();
  const sexPrefill = ((sx as { patient_sex?: string } | null)?.patient_sex ?? "").trim();
  const sep = spec.dateSep ?? "/"; // forms with MM/DD/YYYY divider boxes space the digits
  const collectionDate = fmtDate(c.collection_date as string | null, sep);

  // The order/accession/sample # the staff entered lives in lab_external_ref
  // (the "Accession #" field on the case). Pull it for EVERY mode — including
  // Kennedy (manual) and DoctorsData (assign) — so a typed order # never gets
  // dropped. Only synthesize a DD- ref from the tracking # when assign-mode has
  // nothing entered. An explicit opts.orderNumber still wins.
  const caseRef = (c.lab_external_ref as string | null)?.trim() ?? "";
  let orderNumber = opts.orderNumber ?? caseRef;
  if (!orderNumber && spec.orderNumber === "assign") {
    orderNumber = c.tracking_number ? `DD-${String(c.tracking_number).slice(-8)}` : "";
  }

  const data: ReqFormData = {
    patientName: fullName,
    firstName: first,
    lastName: last,
    mi,
    dob: fmtDate(dob, sep),
    sex: sexPrefill,
    collectionDate,
    // order/requisition date — defaults to the collection date, staff can edit
    orderDate: collectionDate,
    // Fixed defaults (clinic address/phone, labs@ email, fasting Yes).
    address: CLINIC.address,
    city: CLINIC.city,
    state: CLINIC.state,
    zip: CLINIC.zip,
    phone: CLINIC.phone,
    email: CLINIC.email,
    fastingX: "X",
    orderingProvider: "Virgilio Sanchez, MD",
    orderNumber,
    // Specimen defaults: not a redraw, morning (fasting) draw. Redraw stays a
    // manual override — "redraw" means a re-collection, not just a repeat order.
    redrawNoX: "X",
    collectionAmX: "X",
  };

  // "Has patient been drawn for this test before?" — auto from tracker history:
  // any prior case for this patient that maps to the SAME req-form template.
  // (PB / Zenoti history can feed this too once wired.)
  if (spec.fields.drawnBeforeYesX || spec.fields.drawnBeforeNoX) {
    let q = db.from("lab_cases").select("id, lab_name").neq("id", caseId);
    q = c.patient_email
      ? q.eq("patient_email", c.patient_email)
      : q.eq("patient_name", c.patient_name as string);
    const { data: priors } = await q;
    const drawnBefore = (priors ?? []).some(
      (p) => specForLab((p.lab_name as string | null) ?? null)?.templateKey === spec.templateKey,
    );
    data.drawnBeforeYesX = drawnBefore ? "X" : "";
    data.drawnBeforeNoX = drawnBefore ? "" : "X";
  }

  // Only surface the per-patient variables for editing (Alex: the rest is fixed).
  const editableKeys: string[] = [];
  if (spec.fields.patientName) editableKeys.push("patientName");
  if (spec.fields.lastName) editableKeys.push("lastName", "firstName", "mi");
  editableKeys.push("dob", "sex", "collectionDate");
  if (spec.fields.orderDate) editableKeys.push("orderDate");
  if (spec.fields.orderNumber) editableKeys.push("orderNumber");

  const missing = editableKeys.filter(
    (k) => !data[k as keyof ReqFormData] && (k === "dob" || (k === "orderNumber" && spec.orderNumber === "manual")),
  );
  // expand into checkbox X's + split date segments so the calibrator preview
  // matches exactly what gets stamped.
  return { spec, data: expandStampFields(data), missing, editableKeys };
}
