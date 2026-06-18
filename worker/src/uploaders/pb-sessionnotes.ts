// PracticeBetter session-note poster.
//
// Sibling of practicebetter.ts (which handles labrequest PDF uploads). This
// module CREATES session notes — the IV-charting destination. Verified live
// 2026-06-09 (create + filled-content read-back) against the test patient.
//
// Reuses pbLogin / pbApiHeaders / pbRequest / PB_BASE from practicebetter.ts.
//
// KEY GOTCHA: the sessionnotes API surface returns HTTP 425 ("Too Early")
// unless the `x-api-version: 5.1` header is sent — labrequests is an older
// surface that doesn't require it, which is why both browser fetch and bare
// server-side undici failed until this header was added.
//
// ANSWER ENCODING (decoded + verified from real notes):
//   singlechoicegrid  → answer: { answers: [{ index:<row>, answer:<selectedColIndex> }], aggregates: [] }
//   matrix(shorttext) → answer: { answers: [{ index:<row>, cells:["text", …], isDynamic:false }] }
//   matrix(yesno)     → answer: { answers: [{ index:<row>, cells:["True"|"False"|null, …], isDynamic:false }] }
// Question DEFS are reused verbatim from a reference note (template text, not
// PHI); only the answers are supplied per session.

import {
  pbApiHeaders,
  pbRequest,
  PB_BASE,
  type PbSession,
} from "./practicebetter.js";

const PB_API_VERSION = "5.1";

/** Headers for the sessionnotes surface. Pass write=true for POST/PUT bodies. */
export function pbNoteHeaders(session: PbSession, write = false): Record<string, string> {
  const h: Record<string, string> = {
    ...pbApiHeaders(session),
    "x-api-version": PB_API_VERSION,
    accept: "application/json, text/plain, */*",
  };
  if (write) h["content-type"] = "application/json";
  return h;
}

// ── Loose note types (PB returns ~25 fields; we keep it permissive) ──────
export type PbQuestion = {
  object: string; // "singlechoicegrid" | "matrix" | …
  title?: string;
  rows?: Array<{ label?: string; cells?: unknown[]; isHeader?: boolean }>;
  columns?: Array<{ label?: string; columnType?: string }>;
  [k: string]: unknown;
};
export type PbContentItem = {
  id: string;
  /** Optional: some content items are text/section blocks with no question. */
  question?: PbQuestion;
  answer?: unknown;
  name?: string;
  publishStatus?: string;
  object: string; // "<qtype>content"
};
export type PbSessionNote = {
  id: string;
  name?: string;
  content?: PbContentItem[];
  contentCount?: number;
  [k: string]: unknown;
};

// ── Reads ────────────────────────────────────────────────────────────────
export async function getSessionNote(session: PbSession, noteId: string): Promise<PbSessionNote> {
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${noteId}`, {
    method: "GET",
    headers: pbNoteHeaders(session),
  });
  if (res.statusCode !== 200) {
    throw new Error(`PB getSessionNote ${res.statusCode}: ${(await res.body.text()).slice(0, 200)}`);
  }
  return (await res.body.json()) as PbSessionNote;
}

export async function listSessionNotes(
  session: PbSession,
  clientRecordId: string,
  limit = 50,
): Promise<PbSessionNote[]> {
  const res = await pbRequest(
    `${PB_BASE}/api/consultant/sessionnotes?records=${encodeURIComponent(clientRecordId)}&limit=${limit}&sort=date_desc`,
    { method: "GET", headers: pbNoteHeaders(session) },
  );
  if (res.statusCode !== 200) {
    throw new Error(`PB listSessionNotes ${res.statusCode}`);
  }
  const j = (await res.body.json()) as { items?: PbSessionNote[] } | PbSessionNote[];
  return Array.isArray(j) ? j : j.items ?? [];
}

/** Find a client's PB note on a given DATE whose title overlaps any of `titleKeys`
 *  (each ≥4 chars, matched in both directions). Shared by the post-time duplicate
 *  guard ("don't double-post") AND the PB→tracker reconcile pass ("a note exists
 *  in PB, capture it"). Defensive: a list failure resolves to null so a transient
 *  read error never blocks a post or a sync. */
export async function findSameDayNote(
  session: PbSession,
  clientRecordId: string,
  sessionDate: string,
  titleKeys: string[],
): Promise<PbSessionNote | null> {
  const dateKey = (sessionDate ?? "").slice(0, 10);
  if (!dateKey) return null;
  const norm = (x?: string | null) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const keys = titleKeys.map(norm).filter((k) => k.length >= 4);
  if (!keys.length) return null;
  const notes = await listSessionNotes(session, clientRecordId).catch(() => [] as PbSessionNote[]);
  for (const n of notes) {
    const meta = n as Record<string, unknown>;
    const nDate = String(meta.sessionDate ?? meta.date ?? "").slice(0, 10);
    if (nDate !== dateKey) continue;
    const nName = norm(n.name);
    if (nName && keys.some((k) => nName.includes(k) || k.includes(nName))) return n;
  }
  return null;
}

// ── Answer builders (the verified encoding) ──────────────────────────────

/** singlechoicegrid: pick a column per row. `selectedColByRow[i]` = column index
 *  selected for row i, or null/undefined to leave it unselected (answer:-1). */
export function gridAnswer(
  question: PbQuestion,
  selectedColByRow: Array<number | null | undefined>,
): { answers: Array<{ index: number; answer: number }>; aggregates: [] } {
  const rows = question.rows ?? [];
  return {
    answers: rows.map((_, i) => ({ index: i, answer: selectedColByRow[i] ?? -1 })),
    aggregates: [],
  };
}

/** matrix: one cell value per column, per row. For a shorttext column pass a
 *  string; for a yesno column pass a boolean (→ "True"/"False") or null
 *  (unanswered). `valuesByRow[i]` is the ordered list of cell values for row i. */
export function matrixAnswer(
  question: PbQuestion,
  valuesByRow: Array<Array<string | boolean | null | undefined>>,
): { answers: Array<{ index: number; cells: Array<string | null>; isDynamic: boolean }> } {
  const rows = question.rows ?? [];
  const fmt = (v: string | boolean | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? "True" : "False";
    return String(v);
  };
  return {
    answers: rows.map((_, i) => ({
      index: i,
      cells: (valuesByRow[i] ?? []).map(fmt),
      isDynamic: false,
    })),
  };
}

// ── Scaffold helper ──────────────────────────────────────────────────────

/** Strip the answers from a reference note's content[], leaving the template
 *  scaffold ({id, question, name, object}) ready to attach fresh answers.
 *
 *  IMPORTANT: a "reference note" is a real *filled* note, so its free-text
 *  data leaks two ways — the answer (stripped here) AND `question.rows[].cells`
 *  (e.g. vial LOT NUMBERS baked into the question def). We sanitize the latter:
 *  any cell under a `shorttext` column is a free-text data slot, so its label is
 *  another visit's data — blank it. yes/no cell labels are structural OPTIONS
 *  (e.g. "Right Antecubital", "Yes") and are kept. */
export function scaffoldFromNote(note: PbSessionNote): PbContentItem[] {
  return (note.content ?? []).map((c) => ({
    id: c.id,
    question: sanitizeQuestion(c.question),
    name: c.name,
    publishStatus: "draft",
    object: c.object,
  }));
}

/** Deep-clone a question and blank any free-text (shorttext) cell labels so a
 *  reference note's data (lots, doses, locations) can't leak into a new note.
 *  Some content items (text/section blocks) have no question — passed through. */
export function sanitizeQuestion(question: PbQuestion | undefined): PbQuestion | undefined {
  if (!question) return question;
  const q = structuredClone(question);
  // shorttext cells are free-text data slots, so blank them — EXCEPT a "Standard
  // Dose" column. That column carries the template's protocol-standard dose (e.g.
  // Brain Boost "300mg (12ml)", Vit C 25g "25,000mg (50ml)"), which is the same
  // for every patient (the per-visit amount goes in "Add-On Dose"), so it is
  // template text, not leaked data. Lot #, Expiration and Add-On Dose stay blanked.
  const blankCol = (q.columns ?? []).map(
    (col) => col.columnType === "shorttext" && !/standard dose/i.test(col.label ?? ""),
  );
  for (const row of q.rows ?? []) {
    if (!Array.isArray(row.cells)) continue;
    row.cells = row.cells.map((cell, j) => (blankCol[j] ? {} : cell));
  }
  return q;
}

// ── Update ───────────────────────────────────────────────────────────────
/** Update an existing note (re-post = complete the SAME note, never a duplicate).
 *  PUT /sessionnotes/<id>; PB requires `notesId` + `publishStatus` in the body
 *  (verified live). Returns the note id. */
export async function updateSessionNote(
  session: PbSession,
  noteId: string,
  input: CreateSessionNoteInput,
): Promise<{ id: string }> {
  const body = {
    id: noteId,
    notesId: noteId,
    clientRecordId: input.clientRecordId,
    name: input.name,
    summary: input.summary ?? "",
    sessionDate: input.sessionDate,
    publishStatus: input.publishStatus ?? "draft",
    content: input.content,
    object: "sessionnote",
  };
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${noteId}`, {
    method: "PUT",
    headers: pbNoteHeaders(session, true),
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`PB updateSessionNote ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  const j = JSON.parse(text) as { id?: string };
  return { id: j.id ?? noteId };
}

// ── Delete ───────────────────────────────────────────────────────────────
/** Delete a session note. Uses the note headers (cookie + x-xsrf-token +
 *  x-api-version 5.1) — same write-auth as create. Returns true on success;
 *  treats 404 as already-gone (idempotent). */
export async function deleteSessionNote(session: PbSession, noteId: string): Promise<boolean> {
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${noteId}`, {
    method: "DELETE",
    headers: pbNoteHeaders(session, true),
  });
  const text = await res.body.text();
  if (res.statusCode === 200 || res.statusCode === 204 || res.statusCode === 404) return true;
  throw new Error(`PB deleteSessionNote ${res.statusCode}: ${text.slice(0, 200)}`);
}

// ── Create ───────────────────────────────────────────────────────────────
export type CreateSessionNoteInput = {
  clientRecordId: string;
  name: string;
  summary?: string;
  /** ISO timestamp. */
  sessionDate: string;
  /** Fully-built content items (scaffold + attached `answer`). */
  content: PbContentItem[];
  /** "draft" (default) keeps it out of the client portal until finalized. */
  publishStatus?: "draft" | "published";
};

export async function createSessionNote(
  session: PbSession,
  input: CreateSessionNoteInput,
): Promise<{ id: string; contentCount: number }> {
  const body = {
    clientRecordId: input.clientRecordId,
    name: input.name,
    summary: input.summary ?? "",
    sessionDate: input.sessionDate,
    publishStatus: input.publishStatus ?? "draft",
    content: input.content,
    object: "sessionnote",
  };
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes`, {
    method: "POST",
    headers: pbNoteHeaders(session, true),
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`PB createSessionNote ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  const j = JSON.parse(text) as { id?: string; contentCount?: number; errorMessage?: string };
  if (!j.id) throw new Error(`PB createSessionNote returned no id: ${j.errorMessage ?? text.slice(0, 200)}`);
  return { id: j.id, contentCount: j.contentCount ?? 0 };
}
