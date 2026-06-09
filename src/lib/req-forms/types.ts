// Requisition-form auto-fill — shared types. Each lab's blank req form is a flat
// scanned PDF (no AcroForm fields), so we overlay positioned text onto it. The
// fixed clinic/provider/billing block is already pre-printed on the template; we
// only stamp the per-patient fields.

/** The fields we can overlay. Not every form uses every field. */
export type ReqField =
  | "patientName" // full name (DoctorsData)
  | "firstName"
  | "lastName"
  | "mi"
  | "dob"
  | "sex" // "M" / "F" text near a box, when the form has a fill-in vs checkbox
  | "sexMaleX" // an "X" over the Male checkbox
  | "sexFemaleX" // an "X" over the Female checkbox
  | "collectionDate"
  | "orderDate" // date of the order/requisition (DoctorsData), defaults to collection date
  | "address"
  | "city"
  | "state"
  | "zip"
  | "phone"
  | "email"
  | "orderNumber" // Kennedy Sample ID# (manual) / DoctorsData client ref / Spectracell accession
  | "orderingProvider"
  | "fastingX" // X on the Fasting=Yes box (Alex always selects Yes)
  // Split date segments — forms (e.g. SpectraCell) with separate MM | DD | YYYY
  // boxes; auto-derived from collectionDate / dob (see derive.ts).
  | "collectionMonth"
  | "collectionDay"
  | "collectionYear"
  | "dobMonth"
  | "dobDay"
  | "dobYear"
  | "collectionTime"
  | "collectionAmX" // X on the AM box
  | "collectionPmX" // X on the PM box
  | "fastingYesX" // X on Fasting=Yes (separate-box forms)
  | "fastingNoX" // X on Fasting=No
  | "redrawYesX" // X on "Is this a redraw? Yes"
  | "redrawNoX" // X on "Is this a redraw? No"
  | "drawnBeforeYesX" // "Has patient been drawn for a Micronutrient test before? Yes" — auto from tracker history
  | "drawnBeforeNoX"; // ... No

/** Position of one field on the template. y is measured FROM THE TOP (more
 *  intuitive when eyeballing a scan); the engine converts to pdf-lib's
 *  bottom-left origin. Coordinates are in the template's own point space. */
export type FieldPos = {
  page?: number; // default 0
  x: number;
  yTop: number;
  size?: number; // font size in pts (scans are large → big default)
  maxChars?: number; // truncate to fit
};

export type ReqFormSpec = {
  /** tracker lab_name values this template serves (lowercased substring match). */
  labs: string[];
  label: string; // display name
  templateKey: string; // object key in the req-form-templates storage bucket
  /** Date separator for this form's date fields (default "/"). Forms with
   *  pre-printed MM__DD__YYYY boxes use " " or "  " so digits clear the dividers. */
  dateSep?: string;
  /** Whether the order/sample number is entered by staff (Kennedy) vs assigned. */
  orderNumber: "manual" | "assign" | "accession";
  fields: Partial<Record<ReqField, FieldPos>>;
};

/** Resolved per-patient values to stamp. */
export type ReqFormData = Partial<Record<ReqField, string>>;
