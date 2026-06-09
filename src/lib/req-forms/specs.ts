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
    // Dates are stamped as separate MM | DD | YYYY segments (see derive.ts), so
    // no single-string date / dateSep here — each segment lands in its own box.
    fields: {
      // page is 1415×1870; calibrated in-app
      lastName: { x: 62, yTop: 774, size: 35 },
      firstName: { x: 412, yTop: 770, size: 35 },
      mi: { x: 655, yTop: 764, size: 35 },
      // Date of Birth — MM | DD | YYYY boxes (Gender □M □F sits on this row)
      dobMonth: { x: 49, yTop: 852, size: 42 },
      dobDay: { x: 130, yTop: 851, size: 42 },
      dobYear: { x: 213, yTop: 848, size: 41 },
      sexMaleX: { x: 363, yTop: 853, size: 28 },
      sexFemaleX: { x: 411, yTop: 853, size: 28 },
      // "Has patient been drawn for a Micronutrient test before?" Yes/No
      // (auto from tracker history) — coords first-pass, fine-tune in calibrator
      drawnBeforeYesX: { x: 472, yTop: 851, size: 22 },
      drawnBeforeNoX: { x: 528, yTop: 851, size: 22 },
      address: { x: 129, yTop: 909, size: 35 },
      city: { x: 116, yTop: 972, size: 35 },
      state: { x: 425, yTop: 980, size: 35 },
      zip: { x: 582, yTop: 974, size: 35 },
      phone: { x: 137, yTop: 1045, size: 35 },
      email: { x: 132, yTop: 1105, size: 35, maxChars: 40 },
      // Specimen Information — Collection Date MM | DD | YYYY, Time, AM/PM, Fasting
      collectionMonth: { x: 53, yTop: 604, size: 39 },
      collectionDay: { x: 130, yTop: 605, size: 39 },
      collectionYear: { x: 217, yTop: 604, size: 36 },
      collectionTime: { x: 357, yTop: 602, size: 27 },
      collectionAmX: { x: 436, yTop: 611, size: 22 },
      collectionPmX: { x: 488, yTop: 612, size: 22 },
      fastingYesX: { x: 550, yTop: 612, size: 24 },
      fastingNoX: { x: 629, yTop: 611, size: 23 },
      // Billing — "Is this a redraw?" Yes/No
      redrawYesX: { x: 261, yTop: 1205, size: 24 },
      redrawNoX: { x: 200, yTop: 1206, size: 20 },
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
