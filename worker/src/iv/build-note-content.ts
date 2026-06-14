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
import { standardDoseFor } from "./component-doses.js";

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
  imMedication?: { name?: string; dose?: string; location?: string };
  imShotGiven?: boolean;
  /** Provider who performed the IV (defaults to the Zenoti therapist; staff can
   *  override if a different provider did it). Surfaced in the PB note summary. */
  provider?: string;
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
/** Original-case cell label (for values we echo verbatim, e.g. a standard dose). */
const rawCellLabel = (c: unknown): string => ((c as Cell as { label?: string })?.label ?? "").trim();

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

/** IV Start grid: one row, columns are catheter sizes (templates vary; most
 *  have 20 / 22 / 24). Select the column whose label contains the chosen
 *  gauge/catheter. PICC / 18 / Midline have no column in many grids → no cell
 *  selected, and the catheter is recorded in the note summary instead. */
function ivStartAnswer(q: PbQuestion, cath?: string) {
  const want = lc(cath);
  const colIdx = want ? colIndex(q, (l) => l.includes(want)) : -1;
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
function isComponentsMatrix(q: PbQuestion | undefined): boolean {
  if (!q || q.object !== "matrix") return false;
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

/** Fill the Standard Dose column of a dose-bearing matrix (IV fluids / IV push /
 *  IM) from the protocol catalog, by product row label — other cells stay blank.
 *  Used when the staff didn't enter components/IM, so the template's products show
 *  their standard dose instead of a blank column. Unknown products → blank (same
 *  as before), so this never regresses a template we have no doses for. */
function catalogComponentsAnswer(q: PbQuestion) {
  const n = colCount(q);
  const stdIdx = colIndex(q, (l) => /standard dose/.test(l) || /^dose$/.test(l));
  return matrixAnswer(
    q,
    (q.rows ?? []).map((row) => {
      const cells: Array<string | null> = Array(n).fill(null);
      // Prefer the template's own Standard Dose cell — the protocol constant baked
      // into the reference note, authoritative and PER-TEMPLATE (Vit C 25g vs 50g
      // share the row label "Vitamin C 500mg/ml" but carry different doses here).
      // Fall back to the mined catalog for templates whose dose cell is empty (the
      // base IV note leaves it blank and puts the range in the row LABEL instead).
      const templateDose = stdIdx >= 0 ? rawCellLabel(row.cells?.[stdIdx]) : "";
      const dose = templateDose || standardDoseFor(row.label);
      if (stdIdx >= 0 && dose) cells[stdIdx] = dose;
      return cells;
    }),
  );
}

/** Is this the "IM Medication" matrix (Dose/Lot/Location), not "IM Shot Given"? */
function isImMedicationMatrix(q: PbQuestion | undefined): boolean {
  if (!q || q.object !== "matrix") return false;
  const title = lc(q.title);
  return /im medication|intramuscular/.test(title) && !/shot given/.test(title);
}

/** FORM-DRIVEN IM medication: rebuild the matrix's single row from the entered
 *  IM med (name → row label; dose/location → cells). */
function buildImMedication(q: PbQuestion, im: NonNullable<IvChartInput["imMedication"]>) {
  const n = colCount(q);
  const doseCol = colIndex(q, (l) => /dose/.test(l));
  const locCol = colIndex(q, (l) => /location/.test(l));
  const question: PbQuestion = { ...q, rows: [{ label: im.name ?? "", cells: Array.from({ length: n }, () => ({})) }] };
  const cells: Array<string | null> = Array.from({ length: n }, () => null);
  if (doseCol >= 0) cells[doseCol] = im.dose || null;
  if (locCol >= 0) cells[locCol] = im.location || null;
  return { question, answer: matrixAnswer(question, [cells]) };
}

/** Build the answer for one scaffold item from the chart, or null to skip. */
function answerFor(item: PbContentItem, chart: IvChartInput): unknown {
  const q = item.question;
  if (!q) return undefined; // text/section block — no answer
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
    if (/shot given/.test(title)) {
      // IM shot given → YES on every row; not given / not charted → leave blank.
      return yesNoMatrix(q, () => (chart.imShotGiven ? true : null));
    }
    // IM Medication (rebuilt below if entered) / unfilled components → blank.
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
  const im = chart.imMedication;
  return scaffold.map((item) => {
    let question = item.question;
    let answer = answerFor(item, chart);
    // Form-driven components: replace the template rows with the staff's table.
    if (comps.length && isComponentsMatrix(item.question)) {
      const built = buildComponents(item.question!, comps); // isComponentsMatrix guarantees defined
      question = built.question;
      answer = built.answer;
    } else if (isComponentsMatrix(item.question)) {
      // No staff components → fill Standard Dose from the protocol catalog.
      answer = catalogComponentsAnswer(item.question!);
    } else if (im && (im.name ?? "").trim() && isImMedicationMatrix(item.question)) {
      const built = buildImMedication(item.question!, im);
      question = built.question;
      answer = built.answer;
    } else if (isImMedicationMatrix(item.question)) {
      answer = catalogComponentsAnswer(item.question!);
    }
    const filled: PbContentItem = {
      id: item.id,
      question,
      name: item.name ?? question?.title,
      publishStatus: "draft",
      object: item.object,
    };
    if (answer !== undefined) filled.answer = answer;
    return filled;
  });
}

/** Which key sections are unfilled. Sibling of the app's ivChartMissing
 *  (src/app/labs/iv/chart-util.ts) — keep the two in sync. */
export function ivChartMissing(chart: IvChartInput): string[] {
  const vEmpty = (v?: Record<string, string | undefined>) => !v || !(v.bp || v.spo2 || v.temp || v.hr || v.resp);
  const m: string[] = [];
  if (vEmpty(chart.preVitals)) m.push("pre-vitals");
  if (vEmpty(chart.postVitals)) m.push("post-vitals");
  if (!chart.ivStart?.cath) m.push("IV start");
  if (!(chart.components ?? []).some((c) => (c.name ?? "").trim())) m.push("components");
  return m;
}

/** Pretty catheter/line label for the summary: "picc"→PICC, "midline"→Midline,
 *  a gauge number → "24ga". */
function cathLabel(cath: string): string {
  const c = cath.toLowerCase();
  if (c === "picc") return "PICC";
  if (c === "midline") return "Midline";
  return `${cath}ga`;
}

/** PB note summary. We keep the "incomplete" flag OUT of PB (it lives on the
 *  board instead). Records the performing provider and the catheter/line — the
 *  catheter especially, since PICC / Midline / 18ga have no IV-Start grid column
 *  in many templates, so the summary is the only place they'd otherwise show. */
export function ivNoteSummary(chart: IvChartInput): string {
  const parts: string[] = [];
  const p = (chart.provider ?? "").trim();
  if (p) parts.push(`Provider: ${p}`);
  const cath = (chart.ivStart?.cath ?? "").trim();
  if (cath) parts.push(`Catheter: ${cathLabel(cath)}`);
  return parts.join(" · ");
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
