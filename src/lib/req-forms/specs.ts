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
      // Section 4 — Patient Information (page is 1576×2141; calibrated in-app)
      patientName: { x: 271, yTop: 1320, size: 31 },
      dob: { x: 1059, yTop: 1315, size: 30 },
      sexMaleX: { x: 1273, yTop: 1315, size: 30 },
      sexFemaleX: { x: 1358, yTop: 1314, size: 30 },
      address: { x: 323, yTop: 1352, size: 28 },
      city: { x: 209, yTop: 1395, size: 31 },
      state: { x: 813, yTop: 1384, size: 31 },
      zip: { x: 1370, yTop: 1379, size: 31 },
      phone: { x: 410, yTop: 1428, size: 31 },
      email: { x: 811, yTop: 1420, size: 28, maxChars: 38 },
      // Section 3 — Collection Information
      collectionDate: { x: 1141, yTop: 335, size: 34 },
      // Section 3 — order/requisition date (was the assigned client ref)
      orderDate: { x: 616, yTop: 929, size: 23 },
    },
  },
  {
    labs: ["spectracell"],
    label: "SpectraCell — Test Requisition",
    templateKey: "spectracell.pdf",
    orderNumber: "accession", // requisition # is assigned by SpectraCell (not stamped)
    dateSep: " ", // form has MM/DD/YYYY divider boxes — space the digits so they clear the slashes
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
      // page is 1657×2236; calibrated in-app
      lastName: { x: 185, yTop: 454, size: 40 },
      firstName: { x: 583, yTop: 455, size: 40 },
      mi: { x: 997, yTop: 448, size: 40 },
      sex: { x: 869, yTop: 451, size: 40 },
      dob: { x: 1098, yTop: 448, size: 34 },
      collectionDate: { x: 231, yTop: 552, size: 40 }, // Sample Date
      orderNumber: { x: 637, yTop: 555, size: 40 }, // Sample ID#
      orderingProvider: { x: 1141, yTop: 579, size: 29 },
      fastingX: { x: 936, yTop: 541, size: 32 }, // X on "FASTING □"
    },
  },
];

export function specForLab(labName: string | null): ReqFormSpec | null {
  const ln = (labName ?? "").toLowerCase();
  return REQ_FORM_SPECS.find((s) => s.labs.some((l) => ln.includes(l))) ?? null;
}
