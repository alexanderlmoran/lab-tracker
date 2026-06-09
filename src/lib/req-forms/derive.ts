// Expand the editable values into everything the templates actually stamp:
// checkbox X marks, and MM/DD/YYYY split into separate segments for forms whose
// dates sit in divider boxes (SpectraCell). Pure — shared by the calibrator
// preview, the dialog, and the final fill so all three always agree.

import type { ReqFormData } from "./types";

/** Split "MM/DD/YYYY" (or space/dash separated) into [month, day, year]. */
function parts(mdy: string | undefined): [string, string, string] {
  const p = (mdy ?? "").split(/[\s/.-]+/).filter(Boolean);
  return [p[0] ?? "", p[1] ?? "", p[2] ?? ""];
}

export function expandStampFields(d: ReqFormData): ReqFormData {
  const out: ReqFormData = { ...d };

  // Sex text → an X over the Male/Female checkbox.
  if (d.sex) {
    out.sexMaleX = /^m/i.test(d.sex) ? "X" : "";
    out.sexFemaleX = /^f/i.test(d.sex) ? "X" : "";
  }

  // Date segments (forms with separate boxes position these instead of the
  // single collectionDate / dob string).
  const [cm, cd, cy] = parts(d.collectionDate);
  out.collectionMonth = cm;
  out.collectionDay = cd;
  out.collectionYear = cy;
  const [bm, bd, by] = parts(d.dob);
  out.dobMonth = bm;
  out.dobDay = bd;
  out.dobYear = by;

  // Alex always orders fasting; default the Yes box (he can still blank it).
  if (!out.fastingYesX) out.fastingYesX = "X";

  return out;
}
