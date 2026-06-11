// Maps a charting-form payload (iv_sessions.chart) onto a PB template scaffold,
// producing the filled content[] for createSessionNote.
//
// The scaffold (question DEFS + ids) comes from a reference note via
// scaffoldFromNote(); this attaches the staff-entered answers. Matching is by
// question.title + object + row labels so it works across IV templates (which
// share the same field vocabulary: Initial Assessment, Pre/Post Vitals, IV
// Start, Components, Reaction, Removal).
//
// Coverage v1: Initial Assessment, Pre/Post Vitals, IV Start (catheter) are
// mapped precisely. Components + yes/no rows (reaction/removal/attempts) are
// best-effort and fall back to empty cells (the PB template already carries the
// standard components) — refine as real notes are reviewed.

import {
  gridAnswer,
  matrixAnswer,
  type PbContentItem,
  type PbQuestion,
} from "../uploaders/pb-sessionnotes.js";

// Mirrors the app's IvChart (src/app/labs/iv/actions.ts) — kept local because
// the worker and app are separate build units; the DB column is jsonb so the
// boundary is untyped anyway.
export type IvChartInput = {
  assessment?: Record<string, boolean | undefined>;
  preVitals?: Record<string, string | undefined>;
  postVitals?: Record<string, string | undefined>;
  ivStart?: { cath?: string };
  attempts?: string;
  location?: string;
  infusionFlowingWell?: boolean;
  components?: Array<{ name?: string; standardDose?: string; addOnDose?: string; lot?: string; exp?: string }>;
  infusionReaction?: { occurred?: boolean; note?: string };
  ivRemoval?: boolean;
  pc?: { infusionNumber?: number | null; vialCount?: string };
  notes?: string;
};

const lc = (s?: string) => (s ?? "").toLowerCase();
const rowLabels = (q: PbQuestion) => (q.rows ?? []).map((r) => lc(r.label));

/** Map a vitals object onto a single-column matrix by row label. */
function vitalsAnswer(q: PbQuestion, vitals: Record<string, string | undefined> = {}) {
  const pick = (label: string): string | null => {
    if (/blood pressure|^bp/.test(label)) return vitals.bp ?? null;
    if (/spo2|sp02|o2|sat/.test(label)) return vitals.spo2 ?? null;
    if (/temp/.test(label)) return vitals.temp ?? null;
    if (/heart rate|^hr|pulse/.test(label)) return vitals.hr ?? null;
    if (/resp/.test(label)) return vitals.resp ?? null;
    return null;
  };
  return matrixAnswer(q, rowLabels(q).map((lbl) => [pick(lbl)]));
}

/** Initial Assessment grid: check the box (column 0 = YES) per matched field. */
function assessmentAnswer(q: PbQuestion, a: Record<string, boolean | undefined> = {}) {
  const checkedFor = (label: string): boolean => {
    if (/check.?in/.test(label)) return !!a.initialCheckIn;
    if (/risk|benefit/.test(label)) return !!a.risksDiscussed;
    if (/consent|liability/.test(label)) return !!a.consentSigned;
    if (/intake/.test(label)) return !!a.intakeSigned;
    if (/history|medication/.test(label)) return !!a.historyDiscussed;
    return false;
  };
  // answer = selected column index; 0 = the single "YES" column, -1 = unchecked.
  return gridAnswer(q, rowLabels(q).map((lbl) => (checkedFor(lbl) ? 0 : -1)));
}

/** IV Start grid: one row, columns are catheter sizes (20 / 22 / PICC Line). */
function ivStartAnswer(q: PbQuestion, cath?: string) {
  const cols = q.columns ?? [];
  const want = lc(cath);
  const colIdx = cols.findIndex((c) => {
    const l = lc(c.label);
    if (want === "20") return l.includes("20");
    if (want === "22") return l.includes("22");
    if (want === "picc") return l.includes("picc");
    return false;
  });
  return gridAnswer(q, (q.rows ?? []).map(() => (colIdx >= 0 ? colIdx : -1)));
}

/** Empty matrix answer (cells null per column) — for sections we don't fill. */
function emptyMatrix(q: PbQuestion) {
  const colN = (q.columns ?? []).length || 1;
  return matrixAnswer(q, (q.rows ?? []).map(() => Array(colN).fill(null)));
}

/** Build the answer for one scaffold item from the chart, or null to skip. */
function answerFor(item: PbContentItem, chart: IvChartInput): unknown {
  const q = item.question;
  const title = lc(q.title);
  if (q.object === "singlechoicegrid") {
    if (/initial assessment/.test(title)) return assessmentAnswer(q, chart.assessment);
    if (/iv start|catheter/.test(title)) return ivStartAnswer(q, chart.ivStart?.cath);
    return gridAnswer(q, (q.rows ?? []).map(() => -1));
  }
  if (q.object === "matrix") {
    if (/pre.?infusion vitals/.test(title)) return vitalsAnswer(q, chart.preVitals);
    if (/post.?infusion vitals/.test(title)) return vitalsAnswer(q, chart.postVitals);
    // Components / fluids / reaction / removal / attempts: leave to the template
    // defaults for v1 (standard components are pre-filled by PB).
    return emptyMatrix(q);
  }
  // Unknown question type → omit an answer (PB keeps the template default).
  return undefined;
}

/**
 * Produce the filled content[] for a note: every scaffold item gets a fresh
 * answer derived from the chart (question DEFS reused verbatim).
 */
export function buildIvNoteContent(
  scaffold: PbContentItem[],
  chart: IvChartInput,
): PbContentItem[] {
  return scaffold.map((item) => {
    const answer = answerFor(item, chart);
    const filled: PbContentItem = {
      id: item.id,
      question: item.question,
      name: item.name ?? item.question.title,
      publishStatus: "draft",
      object: item.object,
    };
    if (answer !== undefined) filled.answer = answer;
    return filled;
  });
}

/** Compose the PB note title for a session (PC infusions get the #N (#vials)). */
export function ivNoteTitle(opts: {
  serviceName: string;
  templateHint?: string | null;
  kind?: string;
  pc?: { infusionNumber?: number | null; vialCount?: string };
}): string {
  if (opts.kind === "pc") {
    const n = opts.pc?.infusionNumber;
    const vials = opts.pc?.vialCount;
    const prefix = n ? `Infusion #${n}${vials ? ` (#${vials} Vials)` : ""} - ` : "";
    return `${prefix}Phosphatidylcholine Infusion`;
  }
  return opts.templateHint || opts.serviceName;
}
