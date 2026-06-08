// Per-lab requisition-form specs: which template + where each per-patient field
// is stamped (coordinates in the template's own point space, calibrated against a
// grid overlay). Add a lab here once its template + positions are mapped.

import type { ReqFormSpec } from "./types";

export const REQ_FORM_SPECS: ReqFormSpec[] = [
  {
    labs: ["doctorsdata", "doctors data", "doctor's data"],
    label: "Doctor's Data — Test Requisition",
    templateKey: "doctorsdata.pdf",
    orderNumber: "assign", // no lab order#; we assign one (tied to tracking #)
    fields: {
      // Section 4 — Patient Information (page is 1576×2141; calibrated via grid)
      patientName: { x: 250, yTop: 1310, size: 30 },
      dob: { x: 1025, yTop: 1310, size: 28 },
      sexMaleX: { x: 1290, yTop: 1310, size: 30 },
      sexFemaleX: { x: 1435, yTop: 1310, size: 30 },
      address: { x: 255, yTop: 1352, size: 28 },
      city: { x: 165, yTop: 1397, size: 28 },
      state: { x: 782, yTop: 1397, size: 28 },
      zip: { x: 1300, yTop: 1397, size: 28 },
      phone: { x: 440, yTop: 1442, size: 28 },
      email: { x: 748, yTop: 1442, size: 24, maxChars: 38 },
      // Section 3 — Collection Information
      collectionDate: { x: 1035, yTop: 308, size: 26 },
      // Section 3 — Client Reference (our assigned ref)
      orderNumber: { x: 915, yTop: 1213, size: 28 },
    },
  },
  {
    labs: ["spectracell"],
    label: "SpectraCell — Test Requisition",
    templateKey: "spectracell.pdf",
    orderNumber: "accession", // requisition # is assigned by SpectraCell (not stamped)
    fields: {
      // page is 1415×1870; calibrated via grid
      lastName: { x: 55, yTop: 755, size: 28 },
      firstName: { x: 445, yTop: 755, size: 28 },
      mi: { x: 695, yTop: 755, size: 28 },
      dob: { x: 55, yTop: 862, size: 26 },
      // Gender □M □F sits up on the Date-of-Birth row, not the Address row
      sexMaleX: { x: 372, yTop: 818, size: 28 },
      sexFemaleX: { x: 422, yTop: 818, size: 28 },
      address: { x: 130, yTop: 908, size: 26 },
      city: { x: 100, yTop: 958, size: 26 },
      state: { x: 475, yTop: 958, size: 26 },
      zip: { x: 655, yTop: 958, size: 26 },
      phone: { x: 130, yTop: 1000, size: 26 },
      email: { x: 145, yTop: 1095, size: 24, maxChars: 40 },
      collectionDate: { x: 55, yTop: 602, size: 24 },
      fastingX: { x: 600, yTop: 615, size: 26 }, // X on "Fasting □Yes" (first-pass)
    },
  },
  {
    labs: ["kennedy", "krieger"],
    label: "Kennedy Krieger — Requisition",
    templateKey: "kennedy.pdf",
    orderNumber: "manual", // Sample ID# comes from the kit — staff enters it
    fields: {
      // page is 1657×2236; first-pass positions (verify in preview)
      lastName: { x: 130, yTop: 400, size: 26 },
      firstName: { x: 490, yTop: 400, size: 26 },
      mi: { x: 700, yTop: 400, size: 26 },
      sex: { x: 790, yTop: 400, size: 26 },
      dob: { x: 900, yTop: 400, size: 26 },
      collectionDate: { x: 130, yTop: 485, size: 24 }, // Sample Date
      orderNumber: { x: 490, yTop: 485, size: 24 }, // Sample ID#
      orderingProvider: { x: 970, yTop: 530, size: 22 },
      fastingX: { x: 915, yTop: 470, size: 24 }, // X on "FASTING □" (first-pass)
    },
  },
];

export function specForLab(labName: string | null): ReqFormSpec | null {
  const ln = (labName ?? "").toLowerCase();
  return REQ_FORM_SPECS.find((s) => s.labs.some((l) => ln.includes(l))) ?? null;
}
