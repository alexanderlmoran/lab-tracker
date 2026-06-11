// Build-and-test the PB session-note CREATE, server-side. Creates ONE throwaway
// note on the authorized test patient (Leila) to learn the exact create payload.
// Reads back + prints only id/status (no PHI). Alex deletes the test note after.
//
// Run:  cd worker && npx tsx scripts/pb-sessionnote-create-test.ts
// Each successful run creates ONE note — don't loop it.

import { loadEnvLocal } from "../src/lib/load-env.js";
import {
  pbLogin,
  pbApiHeaders,
  pbRequest,
  PB_BASE,
  type PbSession,
} from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME;
const P = process.env.PB_PASSWORD;
if (!U || !P) throw new Error("PB_USERNAME / PB_PASSWORD required");

const LEILA = "641868664a3099220158325b";
const TODAY = new Date().toISOString();

function hdrs(s: PbSession) {
  return {
    ...pbApiHeaders(s),
    "x-api-version": "5.1",
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
  };
}

// Print a safe summary of a PB note response (no patient profile / PHI).
function summarize(text: string) {
  let j: any;
  try { j = JSON.parse(text); } catch { return { nonJson: text.slice(0, 300) }; }
  return {
    id: j?.id,
    name: typeof j?.name === "string" && j.name.length < 60 ? j.name : "<red>",
    publishStatus: j?.publishStatus,
    completionStatus: j?.completionStatus,
    object: j?.object,
    contentCount: j?.contentCount,
    errorCode: j?.errorCode,
    errorMessage: j?.errorMessage,
  };
}

async function tryCreate(s: PbSession, label: string, body: object) {
  const res = await pbRequest(`${PB_BASE}/api/consultant/sessionnotes`, {
    method: "POST",
    headers: hdrs(s),
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  console.log(`\n[${label}] CREATE → ${res.statusCode}`);
  console.log("  ", JSON.stringify(summarize(text)));
  return { status: res.statusCode, summary: summarize(text) };
}

async function main() {
  const s = await pbLogin(U!, P!);
  console.log(`✓ logged in (company=${s.companyId.slice(0, 6)}…)`);

  const base = {
    name: "TEST – IV charting capture (safe to delete)",
    summary: "automated create-shape test",
    sessionDate: TODAY,
    publishStatus: "draft",
    content: [],
    object: "sessionnote",
  };

  // Attempt A: clientRecordId (string) — PB's labrequest convention.
  const a = await tryCreate(s, "A: clientRecordId", { ...base, clientRecordId: LEILA });
  if (a.status < 300 && a.summary.id) {
    console.log(`\n✅ created note id=${a.summary.id} — STOP. (delete this test note in PB)`);
    return;
  }

  // Attempt B: clientRecord: { id } (nested, as seen in the note GET).
  const b = await tryCreate(s, "B: clientRecord{id}", { ...base, clientRecord: { id: LEILA } });
  if (b.status < 300 && b.summary.id) {
    console.log(`\n✅ created note id=${b.summary.id} — STOP. (delete this test note in PB)`);
    return;
  }

  console.log("\n— both shapes rejected; the errorMessage above is the guide for the next iteration —");
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
