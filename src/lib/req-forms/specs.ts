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
];

export function specForLab(labName: string | null): ReqFormSpec | null {
  const ln = (labName ?? "").toLowerCase();
  return REQ_FORM_SPECS.find((s) => s.labs.some((l) => ln.includes(l))) ?? null;
}
