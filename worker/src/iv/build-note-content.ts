// Maps a charting-form payload (iv_sessions.chart) onto a PB template scaffold,
// producing the filled content[] for createSessionNote.
//
// The scaffold (question DEFS + ids) comes from a reference note via
// scaffoldFromNote() (which sanitizes any leaked free-text from the reference).
// This attaches the staff-entered answers. Matching is by question.title +
// object + row/column labels so it works across IV templates (which share the
// same field vocabulary: Initial Assessment, Pre/Post Vitals, IV Start,
// Attempts/Location, Components, Reaction, Removal).
//
// Coverage: Initial Assessment, Pre/Post Vitals, IV Start (catheter),
// Attempts + Location + infusion-flowing, Infusion Reaction, IV Removal, and the
// components/"IV Fluids" matrix (FORM-DRIVEN: rows are rebuilt from the staff-
// entered component table — name → row label, dose/lot → cells). Sections the
// form doesn't capture (IM Medication / IM Shot Given) are left blank.
//
// yes/no encoding (verified from real notes): the SELECTED column cell = "True",
// all other cells = null. singlechoicegrid: answer = selected column index.

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

type Cell = { label?: string } | Record<string, unknown>;
const lc = (s?: string) => (s ?? "").toLowerCase();
const rowLabels = (q: PbQuestion) => (q.rows ?? []).map((r) => lc(r.label));
const cols = (q: PbQuestion) => q.columns ?? [];
const colCount = (q: PbQuestion) => cols(q).length || 1;
const cellLabel = (c: unknown): string => lc((c as Cell as { label?: string })?.label);

/** Index of the first column whose label/type matches the predicate, or -1. */
function colIndex(q: PbQuestion, pred: (label: string, type: string) => boolean): number {
  return cols(q).findIndex((c) => pred(lc(c.label), lc(c.columnType)));
}

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
  const want = lc(cath);
  const colIdx = colIndex(q, (l) => {
    if (want === "20") return l.includes("20");
    if (want === "22") return l.includes("22");
    if (want === "picc") return l.includes("picc");
    return false;
  });
  return gridAnswer(q, (q.rows ?? []).map(() => (colIdx >= 0 ? colIdx : -1)));
}

/** Build a yes/no row: "True" at the selected column, null elsewhere (the
 *  verified encoding). selectedCol < 0 leaves the whole row unanswered. */
function yesNoCells(ncols: number, selectedCol: number): Array<boolean | null> {
  return Array.from({ length: ncols }, (_, j) => (j >= 0 && j === selectedCol ? true : null));
}

/** "How many attempts to start IV" — a 3-row yes/no matrix (Attempts / Location
 *  / infusion-flowing). Options live in the per-row cell labels, so select by
 *  matching the chosen value against each row's cell labels. */
function attemptsAnswer(q: PbQuestion, chart: IvChartInput) {
  const n = colCount(q);
  const selectInRow = (row: { cells?: unknown[] }, want: (label: string) => boolean) =>
    (row.cells ?? []).findIndex((c) => want(cellLabel(c)));
  const valuesByRow = (q.rows ?? []).map((row) => {
    const label = lc(row.label);
    let sel = -1;
    if (/attempt/.test(label)) {
      const a = chart.attempts;
      if (a) sel = selectInRow(row, (l) => (a === "already" ? /already/.test(l) : l === a));
    } else if (/location/.test(label)) {
      const loc = chart.location;
      if (loc) {
        sel = selectInRow(row, (l) =>
          (loc === "right_antecubital" && /right antecubital/.test(l)) ||
          (loc === "left_antecubital" && /left antecubital/.test(l)) ||
          (loc === "left_arm" && /(left arm|midline)/.test(l)),
        );
      }
    } else if (/flow|comfortable|allergic|swelling/.test(label)) {
      if (chart.infusionFlowingWell === true) sel = selectInRow(row, (l) => /^yes/.test(l));
      else if (chart.infusionFlowingWell === false) sel = selectInRow(row, (l) => /^no/.test(l));
    }
    return yesNoCells(n, sel);
  });
  return matrixAnswer(q, valuesByRow);
}

/** A YES|NO matrix where every row shares one decision (true=YES, false=NO,
 *  null=leave blank). Selects by the YES / NO *column* label. */
function yesNoMatrix(q: PbQuestion, decisionForRow: (rowLabel: string) => boolean | null) {
  const yesCol = colIndex(q, (l) => /^yes/.test(l));
  const noCol = colIndex(q, (l) => /^no/.test(l));
  return matrixAnswer(
    q,
    (q.rows ?? []).map((row) => {
      const d = decisionForRow(lc(row.label));
      const sel = d === null ? -1 : d ? yesCol : noCol;
      return yesNoCells(colCount(q), sel);
    }),
  );
}

/** Empty matrix answer (cells null per column) — for sections we don't fill. */
function emptyMatrix(q: PbQuestion) {
  const n = colCount(q);
  return matrixAnswer(q, (q.rows ?? []).map(() => Array(n).fill(null)));
}

/** Is this the components / "IV Fluids" matrix? (Dose + Lot columns, not IM,
 *  not vitals/attempts/reaction/removal.) */
function isComponentsMatrix(q: PbQuestion): boolean {
  if (q.object !== "matrix") return false;
  const title = lc(q.title);
  if (/vital|attempt|location|reaction|removal/.test(title)) return false;
  if (/\bim\b|intramuscular|shot given/.test(title)) return false;
  return colIndex(q, (l) => /dose/.test(l)) >= 0 && colIndex(q, (l) => /lot/.test(l)) >= 0;
}

/** FORM-DRIVEN components: rebuild the matrix rows from the staff-entered table
 *  (name → row label; dose/lot/exp → cells). Returns the new question (with
 *  fresh rows) and its answer. */
function buildComponents(q: PbQuestion, comps: NonNullable<IvChartInput["components"]>) {
  const n = colCount(q);
  const doseCol = colIndex(q, (l) => /dose/.test(l));
  const lotCol = colIndex(q, (l) => /lot/.test(l));
  const rows = comps.map((c) => ({ label: c.name ?? "", cells: Array.from({ length: n }, () => ({})) }));
  const question: PbQuestion = { ...q, rows };
  const valuesByRow = comps.map((c) => {
    const cells: Array<string | null> = Array.from({ length: n }, () => null);
    const dose = [c.standardDose, c.addOnDose].filter((x) => x && x.trim()).join(" + ");
    if (doseCol >= 0) cells[doseCol] = dose || null;
    if (lotCol >= 0) {
      const lot = [c.lot, c.exp ? `exp ${c.exp}` : ""].filter((x) => x && x.trim()).join(" ");
      cells[lotCol] = lot || null;
    }
    return cells;
  });
  return { question, answer: matrixAnswer(question, valuesByRow) };
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
    if (/attempt|location/.test(title)) return attemptsAnswer(q, chart);
    if (/infusion reaction/.test(title)) return yesNoMatrix(q, () => (chart.infusionReaction?.occurred ? true : false));
    if (/removal/.test(title)) return yesNoMatrix(q, () => (chart.ivRemoval ? true : null));
    // IM Medication / IM Shot Given / unfilled components → leave blank.
    return emptyMatrix(q);
  }
  // Unknown question type → omit an answer (PB keeps the template default).
  return undefined;
}

/**
 * Produce the filled content[] for a note: every scaffold item gets a fresh
 * answer derived from the chart (question DEFS reused; components rows rebuilt).
 */
export function buildIvNoteContent(
  scaffold: PbContentItem[],
  chart: IvChartInput,
): PbContentItem[] {
  const comps = (chart.components ?? []).filter((c) => (c.name ?? "").trim());
  return scaffold.map((item) => {
    let question = item.question;
    let answer = answerFor(item, chart);
    // Form-driven components: replace the template rows with the staff's table.
    if (comps.length && isComponentsMatrix(item.question)) {
      const built = buildComponents(item.question, comps);
      question = built.question;
      answer = built.answer;
    }
    const filled: PbContentItem = {
      id: item.id,
      question,
      name: item.name ?? question.title,
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
