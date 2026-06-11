// Filled-note proof: create ONE note on Leila with two filled content items
// (Initial Assessment checked + Pre-Infusion Vitals with TEST values), then read
// back to confirm answers persisted. Question DEFS are copied from a reference
// note (template text, not PHI); ANSWERS are our own test values.
//
// Run:  cd worker && npx tsx scripts/pb-sessionnote-fill-test.ts   (creates 1 note)

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE, type PbSession } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;
const LEILA = "641868664a3099220158325b";
const REF_NOTE = "6a272b54271793958adbbdc2"; // reference for question defs
const TODAY = new Date().toISOString();

function h(s: PbSession, extra: Record<string, string> = {}) {
  return { ...pbApiHeaders(s), "x-api-version": "5.1", accept: "application/json, text/plain, */*", ...extra };
}
async function getNote(s: PbSession, id: string) {
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes/${id}`, { method: "GET", headers: h(s) });
  return { status: res.statusCode, json: JSON.parse(await res.body.text()) as any };
}

async function main() {
  const s = await pbLogin(U, P);
  console.log(`✓ logged in`);

  const ref = await getNote(s, REF_NOTE);
  const content: any[] = ref.json.content || [];
  const assess = content.find((c) => c.question?.object === "singlechoicegrid" && /initial assessment/i.test(c.question?.title || ""));
  const vitals = content.find((c) => c.question?.object === "matrix" && /pre-infusion vitals/i.test(c.question?.title || ""));
  if (!assess || !vitals) throw new Error(`couldn't find reference items (assess=${!!assess} vitals=${!!vitals})`);

  // Build our own answers — question defs reused verbatim, answers are ours.
  const VITAL_TEST = ["TEST 120/80", "99", "98.6", "72", "16"];
  const newContent = [
    {
      id: assess.id,
      question: assess.question,
      answer: { answers: (assess.question.rows || []).map((_: any, i: number) => ({ index: i, answer: 0 })), aggregates: [] },
      name: assess.question.title,
      publishStatus: "draft",
      object: assess.object,
    },
    {
      id: vitals.id,
      question: vitals.question,
      answer: { answers: (vitals.question.rows || []).map((_: any, i: number) => ({ index: i, cells: [VITAL_TEST[i] ?? ""], isDynamic: false })) },
      name: vitals.question.title,
      publishStatus: "draft",
      object: vitals.object,
    },
  ];

  const body = {
    clientRecordId: LEILA,
    name: "TEST – IV filled-note proof (safe to delete)",
    summary: "filled content[] test",
    sessionDate: TODAY,
    publishStatus: "draft",
    content: newContent,
    object: "sessionnote",
  };
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes`, { method: "POST", headers: h(s, { "content-type": "application/json" }), body: JSON.stringify(body) });
  const created = JSON.parse(await res.body.text()) as any;
  console.log(`CREATE → ${res.statusCode}  id=${created.id}  contentCount=${created.contentCount}  err=${created.errorMessage || "-"}`);
  if (res.statusCode >= 300 || !created.id) { console.log("rejected:", JSON.stringify(created).slice(0, 400)); return; }

  // Read back and verify our answers stuck (these are OUR test values, safe to print).
  const back = await getNote(s, created.id);
  const bc: any[] = back.json.content || [];
  const bvitals = bc.find((c) => /pre-infusion vitals/i.test(c.question?.title || ""));
  const bassess = bc.find((c) => /initial assessment/i.test(c.question?.title || ""));
  console.log(`READBACK → ${back.status}  contentCount=${back.json.contentCount}`);
  console.log("  vitals cells:", JSON.stringify((bvitals?.answer?.answers || []).map((a: any) => a.cells)));
  console.log("  assessment answers:", JSON.stringify((bassess?.answer?.answers || []).map((a: any) => a.answer)));
  console.log(`\n✅ filled note id=${created.id} — delete this test note in PB.`);
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
