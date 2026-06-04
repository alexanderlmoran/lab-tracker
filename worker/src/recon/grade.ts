// Capture-confidence grader — the gate that decides whether a freshly captured
// lab result is certain enough to AUTO-POST to a patient's PB chart, or should
// be left in Pending Upload for Nadia + Alex to review.
//
// Pure logic, no I/O. The caller assembles the signals (identity match, date
// proximity, portal status, PDF validity) and we return a 0-100 score + a
// decision. A v2 may fold in an AI grader (reading the PDF to confirm the
// patient + report type); that just becomes another signal/override here.
//
// Distinct from the PB-match confidence in backfill/engine.ts: THAT decides
// "is this already on PB?" (a reversible status flip). THIS decides "is this
// capture safe to write onto a chart?" — higher stakes, so the bar is 90.

export type CaptureSignals = {
  /** Portal row's patient name matches the case's patient name. */
  patientNameMatch: boolean;
  /** Portal row's DOB matches the case DOB. null = case has no DOB to compare. */
  patientDobMatch: boolean | null;
  /** The case's stored accession exactly equals the portal row's accession. */
  hasAccessionExact: boolean;
  /** |portal collection date − case draw/anchor date| in days. null = no anchor. */
  daysOffAnchor: number | null;
  /** Portal marks the result Complete (vs Incomplete/pending). */
  portalStatusComplete: boolean;
  /** Portal row has a non-empty final/result date. */
  hasFinalDate: boolean;
  /** Downloaded PDF size in bytes. Omit/undefined when not yet downloaded
   *  (e.g. a dry-run that only listed candidates). null is treated the same. */
  pdfBytes?: number | null;
};

export type CaptureGrade = {
  score: number; // 0-100
  decision: "auto-post" | "flag";
  reasons: string[];
};

/** At/above this, the engine auto-posts; below it, the card stays Pending Upload
 *  flagged for a human. Alex's line: "less than 90% → manual". */
export const AUTO_POST_THRESHOLD = 90;

export function gradeCapture(s: CaptureSignals): CaptureGrade {
  // Hard disqualifiers first — posting the wrong patient's report is the single
  // worst failure, so an explicit DOB mismatch or a name miss can't be bought
  // back by any other signal.
  if (s.patientDobMatch === false) {
    return { score: 5, decision: "flag", reasons: ["DOB mismatch — wrong-patient risk"] };
  }
  if (!s.patientNameMatch) {
    return { score: 0, decision: "flag", reasons: ["patient name did not match"] };
  }

  let score = 0;
  const reasons: string[] = [];

  // Identity (the dominant signal).
  if (s.patientDobMatch === true) {
    score += 50;
    reasons.push("name+dob exact (+50)");
  } else {
    score += 35;
    reasons.push("name match, dob unverified (+35)");
  }

  // Accession identity — the gold-standard match key.
  if (s.hasAccessionExact) {
    score += 30;
    reasons.push("accession exact (+30)");
  }

  // Date proximity between the portal collection date and the case's draw date.
  if (s.daysOffAnchor == null) {
    reasons.push("no draw date to corroborate (0)");
  } else if (s.daysOffAnchor <= 7) {
    score += 15;
    reasons.push("collected ≤7d from draw (+15)");
  } else if (s.daysOffAnchor <= 21) {
    score += 10;
    reasons.push("collected ≤21d from draw (+10)");
  } else if (s.daysOffAnchor <= 45) {
    score += 5;
    reasons.push("collected ≤45d from draw (+5)");
  } else {
    reasons.push(`collected ${Math.round(s.daysOffAnchor)}d off (0)`);
  }

  // Completeness.
  if (s.portalStatusComplete && s.hasFinalDate) {
    score += 15;
    reasons.push("portal Complete + final date (+15)");
  } else {
    reasons.push("not marked Complete w/ final date (0)");
  }

  // PDF validity — only contributes once the PDF has actually been pulled.
  if (s.pdfBytes != null) {
    if (s.pdfBytes >= 20_000) {
      score += 5;
      reasons.push("PDF looks valid (+5)");
    } else {
      reasons.push(`PDF only ${s.pdfBytes}B — suspicious (0)`);
    }
  }

  score = Math.min(100, score);
  return {
    score,
    decision: score >= AUTO_POST_THRESHOLD ? "auto-post" : "flag",
    reasons,
  };
}
