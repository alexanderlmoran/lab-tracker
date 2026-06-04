// Unit tests for the capture-confidence grader. Pure logic — run with:
//   cd worker && npx tsx --test src/recon/grade.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCapture, AUTO_POST_THRESHOLD, type CaptureSignals } from "./grade.js";

function sig(overrides: Partial<CaptureSignals> = {}): CaptureSignals {
  return {
    patientNameMatch: true,
    patientDobMatch: true,
    hasAccessionExact: false,
    daysOffAnchor: 1,
    portalStatusComplete: true,
    hasFinalDate: true,
    pdfBytes: 285_000,
    ...overrides,
  };
}

test("DOB mismatch is disqualifying regardless of everything else", () => {
  const g = gradeCapture(sig({ patientDobMatch: false, hasAccessionExact: true }));
  assert.equal(g.decision, "flag");
  assert.ok(g.score < AUTO_POST_THRESHOLD);
});

test("name miss is disqualifying", () => {
  const g = gradeCapture(sig({ patientNameMatch: false }));
  assert.equal(g.decision, "flag");
  assert.equal(g.score, 0);
});

test("name+dob+accession+close+complete+pdf → auto-post (caps at 100)", () => {
  const g = gradeCapture(sig({ hasAccessionExact: true }));
  assert.equal(g.score, 100);
  assert.equal(g.decision, "auto-post");
});

test("name+dob+close+complete+pdf but NO accession → 85 → flag", () => {
  // 50 + 15 + 15 + 5 = 85 (the user's 90 line keeps accession-less captures human)
  const g = gradeCapture(sig({ hasAccessionExact: false }));
  assert.equal(g.score, 85);
  assert.equal(g.decision, "flag");
});

test("name-only (dob unknown) + accession + close + complete → 95 → auto-post", () => {
  // 35 + 30 + 15 + 15 = 95 (+5 pdf would also push it over; here pdf omitted)
  const g = gradeCapture(
    sig({ patientDobMatch: null, hasAccessionExact: true, pdfBytes: undefined }),
  );
  assert.equal(g.score, 95);
  assert.equal(g.decision, "auto-post");
});

test("accession exact survives a far-off date (the gold key holds)", () => {
  // 50 + 30 + 0(date) + 15 + 5 = 100
  const g = gradeCapture(sig({ hasAccessionExact: true, daysOffAnchor: 400 }));
  assert.equal(g.decision, "auto-post");
});

test("Incomplete portal status drops below the line without an accession", () => {
  // 50 + 15(date) + 0(not complete) + 5(pdf) = 70
  const g = gradeCapture(sig({ portalStatusComplete: false, hasFinalDate: false }));
  assert.equal(g.score, 70);
  assert.equal(g.decision, "flag");
});

test("tiny PDF earns no validity points", () => {
  const g = gradeCapture(sig({ hasAccessionExact: true, pdfBytes: 1200 }));
  // 50 + 30 + 15 + 15 = 110 → capped 100 still, accession dominates
  assert.equal(g.score, 100);
  // but without accession the tiny pdf matters: 50 + 15 + 15 = 80
  const g2 = gradeCapture(sig({ pdfBytes: 1200 }));
  assert.equal(g2.score, 80);
  assert.equal(g2.decision, "flag");
});
