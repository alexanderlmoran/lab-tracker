import "server-only";
import type { InboundEmailExtracted, LabCase } from "@/lib/types";

export type MatchResult = {
  caseId: string | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

/** Match an extracted lab report to an open lab case.
 * High = name + lab + non-archived match. Medium = name match only.
 * Low = email match. None = nothing close. */
export function matchCase(
  extracted: InboundEmailExtracted,
  cases: LabCase[],
): MatchResult {
  const active = cases.filter((c) => !c.deleted_at && !c.archived_at);
  const targetName = extracted.patient_name
    ? normalize(extracted.patient_name)
    : null;
  const targetEmail = extracted.patient_email?.toLowerCase().trim() ?? null;
  const targetLab = extracted.lab_name
    ? normalize(extracted.lab_name)
    : null;

  if (targetName) {
    // High confidence: name + lab match in active cases.
    if (targetLab) {
      const exact = active.find(
        (c) =>
          normalize(c.patient_name) === targetName &&
          normalize(c.lab_name).includes(targetLab),
      );
      if (exact) {
        return {
          caseId: exact.id,
          confidence: "high",
          reason: "Patient name + lab name match on an active case.",
        };
      }
    }
    // Medium confidence: name match in active cases (lab differs).
    const nameOnly = active.find(
      (c) => normalize(c.patient_name) === targetName,
    );
    if (nameOnly) {
      return {
        caseId: nameOnly.id,
        confidence: "medium",
        reason: "Patient name matches an active case (lab name differs).",
      };
    }
  }

  if (targetEmail) {
    const byEmail = active.find(
      (c) => c.patient_email.toLowerCase() === targetEmail,
    );
    if (byEmail) {
      return {
        caseId: byEmail.id,
        confidence: "low",
        reason: "Patient email matches an active case.",
      };
    }
  }

  return {
    caseId: null,
    confidence: "none",
    reason: "No active case matches by name, lab, or email.",
  };
}
