// Unit tests for the Backfill Brain classifier. Pure logic, no I/O — run with:
//   cd worker && npx tsx --test src/backfill/engine.test.ts
//
// The engine drives real mutations on patient data (silent step5 advances),
// so its matching rules are worth pinning down precisely.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCase,
  matchCaseToPbLabRequest,
  type BackfillCase,
} from "./engine.js";
import type { PbLabRequest } from "../uploaders/practicebetter.js";

// Fixed "now" so age math is deterministic.
const NOW = new Date("2026-05-31T00:00:00Z");

function makeCase(overrides: Partial<BackfillCase> = {}): BackfillCase {
  return {
    caseId: "case-1",
    patientName: "Leila Centner",
    patientDob: "1976-12-28",
    labName: "Access",
    collectionDate: "2026-03-01",
    createdAt: "2026-03-01T12:00:00Z",
    zenotiAppointmentId: "zen-1",
    labExternalRef: null,
    panelHint: null,
    step1: true,
    step2: false,
    step3: false,
    step4: false,
    step5: false,
    ...overrides,
  };
}

function makeLr(overrides: Partial<PbLabRequest> = {}): PbLabRequest {
  return {
    id: "pb-1",
    name: "Access — Acc# 007143558",
    dateOrdered: "2026-03-05",
    ...overrides,
  } as PbLabRequest;
}

// ── Anchor tests: existing behavior we must not regress ────────────────────

test("step5-complete cases are left alone", () => {
  const d = classifyCase(makeCase({ step5: true }), [], NOW);
  assert.equal(d.action, "leave");
  assert.equal(d.confidence, "high");
});

test("recent case within grace window is left as legitimately pending", () => {
  const d = classifyCase(
    makeCase({ collectionDate: "2026-05-20" }), // 11 days < 30d grace
    [makeLr()],
    NOW,
  );
  assert.equal(d.action, "leave");
});

test("bulk-import historical (no zenoti id, no collection_date) skips grace", () => {
  // created_at is yesterday but it's a historical import — must NOT be left.
  const d = classifyCase(
    makeCase({
      zenotiAppointmentId: null,
      collectionDate: null,
      createdAt: "2026-05-30T12:00:00Z",
      labExternalRef: null,
    }),
    [], // no PB match
    NOW,
  );
  assert.equal(d.action, "needs-review");
});

test("accession embedded in PB name → already-on-pb, high confidence", () => {
  const d = classifyCase(
    makeCase({ labExternalRef: "007143558", labName: "Whatever" }),
    [makeLr({ name: "Some Lab — Acc# 007143558", dateOrdered: "2026-04-30" })],
    NOW,
  );
  assert.equal(d.action, "already-on-pb");
  assert.equal(d.confidence, "high");
});

test("lab-name substring match within 7 days → high", () => {
  const r = matchCaseToPbLabRequest(makeCase({ collectionDate: "2026-03-01" }), [
    makeLr({ name: "Access Custom", dateOrdered: "2026-03-05" }),
  ]);
  assert.ok(r);
  assert.equal(r.confidence, "high");
});

test("lab-name substring match within 21 days → medium", () => {
  const r = matchCaseToPbLabRequest(makeCase({ collectionDate: "2026-03-01" }), [
    makeLr({ name: "Access Custom", dateOrdered: "2026-03-18" }),
  ]);
  assert.ok(r);
  assert.equal(r.confidence, "medium");
});

test("panel-hint substring match within 21 days → medium (capped)", () => {
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Custom", panelHint: "telomere", collectionDate: "2026-03-01" }),
    [makeLr({ name: "Life Length Telomere Test", dateOrdered: "2026-03-10" })],
  );
  assert.ok(r);
  assert.equal(r.confidence, "medium");
});

test("no PB match but accession present → scrape-needed", () => {
  const d = classifyCase(
    makeCase({ labExternalRef: "ACC123", labName: "Genova" }),
    [makeLr({ name: "Unrelated Lab", dateOrdered: "2026-03-05" })],
    NOW,
  );
  assert.equal(d.action, "scrape-needed");
});

test("no PB match, no accession → needs-review", () => {
  const d = classifyCase(
    makeCase({ labName: "ReliGen", labExternalRef: null }),
    [makeLr({ name: "Unrelated Lab", dateOrdered: "2026-03-05" })],
    NOW,
  );
  assert.equal(d.action, "needs-review");
});

// ── New behavior: word-token overlap matching ──────────────────────────────
//
// Substring matching misses "vaginal microbiome" ⊄ "Microbiome Labs (BIOMEFX)"
// because of word ordering. A shared content word (≥4 chars, not a stopword)
// should still surface the PB labrequest — but only at LOW confidence, since
// token overlap is the fuzziest signal and must never auto-advance.

test("token overlap on panel hint surfaces the PB labrequest at low confidence", () => {
  const d = classifyCase(
    makeCase({
      labName: "Custom",
      panelHint: "Vaginal Microbiome",
      collectionDate: "2026-03-03",
    }),
    [makeLr({ id: "pb-mb", name: "Microbiome Labs (BIOMEFX)", dateOrdered: "2026-03-10" })],
    NOW,
  );
  assert.equal(d.action, "already-on-pb");
  assert.equal(d.confidence, "low");
  assert.equal(d.pbLabRequest?.id, "pb-mb");
});

test("token overlap never produces high or medium confidence", () => {
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Custom", panelHint: "Vaginal Microbiome", collectionDate: "2026-03-03" }),
    [makeLr({ name: "Microbiome Labs (BIOMEFX)", dateOrdered: "2026-03-04" })], // 1 day off
  );
  assert.ok(r);
  assert.notEqual(r.confidence, "high");
  assert.notEqual(r.confidence, "medium");
});

test("stopword-only overlap does NOT match (no false positive)", () => {
  // "lab", "test", "results", "panel" are filler — sharing them must not match.
  const d = classifyCase(
    makeCase({ labName: "Custom", panelHint: "Lab Test", collectionDate: "2026-03-01" }),
    [makeLr({ name: "Other Results Panel", dateOrdered: "2026-03-05" })],
    NOW,
  );
  assert.equal(d.action, "needs-review");
});

test("short shared word (<4 chars) does NOT trigger a token match", () => {
  // "b12" is 3 chars — too short to be a reliable signal.
  const d = classifyCase(
    makeCase({ labName: "Custom", panelHint: "B12 Draw", collectionDate: "2026-03-01" }),
    [makeLr({ name: "B12 Folate Panel", dateOrdered: "2026-03-05" })],
    NOW,
  );
  assert.equal(d.action, "needs-review");
});

test("a stronger name match outranks a closer token match", () => {
  // Name substring (strength) must win over a date-closer token candidate.
  // pb-token matches only by word overlap (no substring), so it must not
  // beat the genuine name match despite being 39 days closer.
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Access", panelHint: "Microbiome Vaginal", collectionDate: "2026-03-01" }),
    [
      makeLr({ id: "pb-name", name: "Access Labs", dateOrdered: "2026-01-20" }), // 40d, name substring
      makeLr({ id: "pb-token", name: "Vaginal Swab Microbiome Center", dateOrdered: "2026-03-02" }), // 1d, token only
    ],
  );
  assert.ok(r);
  assert.equal(r.match.id, "pb-name");
});

test("token match beyond the 90-day window is excluded", () => {
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Custom", panelHint: "Microbiome", collectionDate: "2026-03-01" }),
    [makeLr({ name: "Microbiome Labs", dateOrdered: "2025-10-01" })], // ~150 days off
  );
  assert.equal(r, null);
});

// ── Guardrails against silent wrong-patient advances ───────────────────────

test("a short accession ref (<6 chars) must NOT reach high / auto-advance", () => {
  // "55" is an incidental substring of an unrelated PB accession. It must
  // not be treated as an accession identity match.
  const d = classifyCase(
    makeCase({ labName: "Whatever", labExternalRef: "55" }),
    [makeLr({ name: "Quest — Acc# 9955123", dateOrdered: "2026-03-05" })],
    NOW,
  );
  assert.notEqual(d.action, "already-on-pb");
  assert.notEqual(d.confidence, "high");
});

test("accession matches on a whole token, not a substring of a longer number", () => {
  // ref "77" is inside "7799" but is not its own token → no accession match.
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Access", labExternalRef: "770000", collectionDate: "2026-03-01" }),
    [makeLr({ name: "Unrelated 7700001 Panel", dateOrdered: "2026-03-02" })],
  );
  assert.equal(r, null);
});

test("a far-dated accession candidate does not outrank a close name+date match", () => {
  const r = matchCaseToPbLabRequest(
    makeCase({ labName: "Access", labExternalRef: "007143558", collectionDate: "2026-03-01" }),
    [
      makeLr({ id: "pb-junk", name: "Unrelated — Acc# 007143558", dateOrdered: "2024-03-01" }), // ~2yr off
      makeLr({ id: "pb-name", name: "Access Custom", dateOrdered: "2026-03-03" }), // 2 days off, name
    ],
  );
  assert.ok(r);
  assert.equal(r.match.id, "pb-name");
});

test("an ultra-short labName (1 char) must NOT reach high", () => {
  const d = classifyCase(
    makeCase({ labName: "A", labExternalRef: null }),
    [makeLr({ name: "Microbiome Labs", dateOrdered: "2026-03-03" })],
    NOW,
  );
  assert.notEqual(d.action, "already-on-pb");
  assert.notEqual(d.confidence, "high");
});

test("a 2-char labName does not substring-match a longer PB name", () => {
  const d = classifyCase(
    makeCase({ labName: "DX", labExternalRef: null }),
    [makeLr({ name: "MicrogenDX Results", dateOrdered: "2026-03-03" })],
    NOW,
  );
  assert.notEqual(d.action, "already-on-pb");
});

test("bulk-import historical matches an OLD PB labrequest by name (the feature's whole point)", () => {
  // createdAt is the spreadsheet insert time; the real lab is months older.
  // A genuine name match dated long before createdAt must still resolve.
  const d = classifyCase(
    makeCase({
      zenotiAppointmentId: null,
      collectionDate: null,
      createdAt: "2026-05-30T12:00:00Z",
      labName: "Access",
    }),
    [makeLr({ name: "Access Labs", dateOrdered: "2026-01-01" })], // 149d before insert
    NOW,
  );
  assert.equal(d.action, "already-on-pb");
  // Anchor date is unreliable for these rows, so it must never auto-advance.
  assert.notEqual(d.confidence, "high");
});

test("garbage PB dateOrdered is excluded like a missing date (non-accession)", () => {
  const d = classifyCase(
    makeCase({ labName: "Access", labExternalRef: null }),
    [makeLr({ name: "Access Labs", dateOrdered: "not-a-date" })],
    NOW,
  );
  assert.equal(d.action, "needs-review");
});

test("a future collection_date is treated as recent (grace), not aged", () => {
  const d = classifyCase(
    makeCase({ collectionDate: "2026-12-01", zenotiAppointmentId: "zen-1" }), // 6 months in the future
    [makeLr({ name: "Access Custom", dateOrdered: "2026-12-02" })],
    NOW,
  );
  assert.equal(d.action, "leave");
});
