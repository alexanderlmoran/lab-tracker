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

/** Read an env var, stripping a single layer of matching surrounding quotes —
 *  Vercel/.env values sometimes carry literal quotes (e.g. PRACTICE_NAME set to
 *  `'Centner Wellness'`) that would otherwise print verbatim on the form. */
function envClean(name: string): string | undefined {
  const v = process.env[name];
  return v == null ? v : v.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/** Constant / derived auto-fills for a template's CUSTOM calibrator fields,
 *  matched by the field's LABEL. Every label this returns is treated as MANAGED:
 *  it's stamped automatically AND hidden from the print dialog, so staff only see
 *  the genuinely per-patient fields (like the KK/SpectraCell forms). `ctx.orderDate`
 *  feeds the date fields that track the requisition date.
 *  Returns {} for templates with no managed fields. */
export function reqFormCustomDefaults(
  templateKey: string,
  ctx: { orderDate?: string; patientName?: string } = {},
): Record<string, string> {
  if (templateKey === "mitoswab.pdf") {
    const out: Record<string, string> = {
      // Sample type — always a NEW sample (X), never a replacement.
      NewSample: "X",
      ReplacementSample: "",
      // Fixed reporting / billing assertions.
      ReportEmail: "X", // provider preferred reporting = Email
      BillingYes: "X",
      CreditCard: "X", // pay-by-credit-card box
      DiagnosisCode: "Z00.00",
      // Dates track the order/requisition date.
      PhysicianDate: ctx.orderDate ?? "",
      ConsentDate: ctx.orderDate ?? "",
      // Facility / provider constants.
      FacilityName: envClean("PRACTICE_NAME") || "Centner Wellness",
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
      // The PATIENT is the self-pay responsible party (the clinic card is just the
      // payment method, charted in the CreditCard block). NOT env-overridable: the
      // responsible-party NAME is per-patient (it changes every form), and the
      // relationship is always Self. (A static CLINIC_RESPONSIBLE_PARTY="Self" env
      // was wrongly overriding the patient name — that's why it printed "Self".)
      RelationshipToPatient: "Self",
      ResponsiblePartName: ctx.patientName || "",
      BillingZipCode: envClean("CLINIC_BILLING_ZIP") || CLINIC.zip,
      InvoiceEmail: envClean("CLINIC_INVOICE_EMAIL") || CLINIC.email,
    };
    // Credit-card fields are SENSITIVE — sourced ONLY from env, never the repo.
    // The clinic's GENERAL billing card (shared with Kennedy/Doctors forms).
    // Included (→ stamped + hidden as constants) only when set; until then they
    // stay editable per-case so nothing breaks before the env is configured.
    // Set in the deployment env: CLINIC_CC_NAME / CLINIC_CC_NUMBER /
    // CLINIC_CC_EXP / CLINIC_CC_CVV.
    const ccName = envClean("CLINIC_CC_NAME");
    const ccNumber = envClean("CLINIC_CC_NUMBER");
    const ccExp = envClean("CLINIC_CC_EXP");
    const ccCvv = envClean("CLINIC_CC_CVV");
    if (ccName) out.CreditCardName = ccName;
    if (ccNumber) out.CreditCardNumber = ccNumber;
    if (ccExp) out.CreditCardExpiration = ccExp;
    if (ccCvv) out.CreditCardCVV = ccCvv;
    return out;
  }
  return {};
}

/** Dropdown options for a template's custom fields, keyed by LABEL. A field with
 *  options renders as a <select> in the print dialog; everything else is a text
 *  input. MitoSwab "TechInitial" is the clinic's tech list, set via the
 *  MITOSWAB_TECHS env (comma-separated, e.g. "AM,RS,CA"). Empty → text input. */
export function reqFormCustomSelects(templateKey: string): Record<string, string[]> {
  if (templateKey === "mitoswab.pdf") {
    const techs = (process.env.MITOSWAB_TECHS || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return techs.length ? { TechInitial: techs } : {};
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
    // Morning (fasting) draw default. Redraw is intentionally NOT pre-selected
    // (Alex: "preselected without my input"): it's a per-draw re-collection
    // decision staff make by hand. The SpectraCell Yes/No boxes also need a
    // visual calibration check first — the No-X x-coord looks transposed onto the
    // Yes box (see specs.ts redrawYesX/redrawNoX).
    collectionAmX: "X",
  };

  // "Has patient been drawn for this test before?" — auto from tracker history:
  // any prior case for this patient that maps to the SAME req-form template.
  // (PB / Zenoti history can feed this too once wired.)
  if (spec.fields.drawnBeforeYesX || spec.fields.drawnBeforeNoX) {
    // Find prior cases for THIS patient that map to the same template. Match on a
    // real email OR the (case-insensitive) name — NOT email-only — because a
    // patient's cases drift across their real PB email and the synthetic Zenoti
    // placeholder (`…@unknown.zenoti.local`), and names are stored mixed-case.
    // Either signal matching counts (was email-exact-only → missed Leila's many
    // prior SpectraCell draws, so it wrongly printed "not drawn before").
    const rawEmail = c.patient_email as string | null;
    const realEmail = rawEmail && !/@unknown\.zenoti\.local$/i.test(rawEmail) ? rawEmail : null;
    const name = (c.patient_name as string | null)?.trim();
    const priors: Array<{ lab_name: string | null }> = [];
    if (realEmail) {
      const { data } = await db.from("lab_cases").select("lab_name").neq("id", caseId).eq("patient_email", realEmail);
      if (data) priors.push(...(data as Array<{ lab_name: string | null }>));
    }
    if (name) {
      const { data } = await db.from("lab_cases").select("lab_name").neq("id", caseId).ilike("patient_name", name);
      if (data) priors.push(...(data as Array<{ lab_name: string | null }>));
    }
    const drawnBefore = priors.some(
      (p) => specForLab(p.lab_name ?? null)?.templateKey === spec.templateKey,
    );
    data.drawnBeforeYesX = drawnBefore ? "X" : "";
    data.drawnBeforeNoX = drawnBefore ? "" : "X";
  }

  // Only surface the per-patient variables for editing (Alex: the rest is fixed).
  const editableKeys: string[] = [];
  if (spec.fields.patientName) editableKeys.push("patientName");
  if (spec.fields.lastName) editableKeys.push("lastName", "firstName", "mi");
  editableKeys.push("dob", "sex", "collectionDate");
  // Collection TIME — forms that position it (SpectraCell) get an editable input
  // so staff stamp the real draw time. It was never resolved or surfaced before,
  // so the positioned box always printed blank. Blank default (no fabricated
  // draw time); the AM box is still auto-X'd for the typical morning draw.
  if (spec.fields.collectionTime) editableKeys.push("collectionTime");
  if (spec.fields.orderDate) editableKeys.push("orderDate");
  if (spec.fields.orderNumber) editableKeys.push("orderNumber");

  const missing = editableKeys.filter(
    (k) => !data[k as keyof ReqFormData] && (k === "dob" || (k === "orderNumber" && spec.orderNumber === "manual")),
  );
  // expand into checkbox X's + split date segments so the calibrator preview
  // matches exactly what gets stamped.
  return { spec, data: expandStampFields(data), missing, editableKeys };
}
