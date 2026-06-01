// Probe PracticeBetter for resource types beyond labrequests.
//
// Alex sees lab results on Leila's PB /labs view that we don't see in our
// listAllConsultantLabRequests dump (Tiny Health, MicrogenDX, BIOMEFX, Evvy,
// Juno, Life Length Telomere Test). These are likely PB "lab results" or
// "documents" attached without an associated labrequest. This script tries
// candidate endpoints, dumps a small sample of each, and looks for the
// known-existing "Life Length Telomere Test" Dec 17 2025 entry to confirm.

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, findPbPatient } from "../src/uploaders/practicebetter.js";

loadEnvLocal();

const PB_BASE = "https://my.practicebetter.io";

function headers(session: {
  cookies: string;
  csrfToken: string;
  companyId: string;
  sessionId: string;
}): Record<string, string> {
  return {
    cookie: session.cookies,
    "x-xsrf-token": session.csrfToken,
    "x-company-id": session.companyId,
    "x-session-id": session.sessionId,
    "x-platform": "web",
    "x-timezone": "America/New_York,en-us",
    accept: "application/json, text/plain, */*",
  };
}

async function probe(label: string, url: string, h: Record<string, string>) {
  const res = await request(url, { method: "GET", headers: h });
  const text = await res.body.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* keep as text */ }
  const preview =
    json && typeof json === "object"
      ? JSON.stringify(json, null, 2).slice(0, 1200)
      : text.slice(0, 600);
  console.log(`\n──── ${label}`);
  console.log(`GET ${url}`);
  console.log(`status=${res.statusCode}`);
  console.log(preview);
  return { status: res.statusCode, json, text };
}

async function main() {
  const session = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const patient = await findPbPatient(session, "Leila Centner", "1976-12-28");
  if (!patient) throw new Error("Leila not found");
  console.log(`Patient id = ${patient.id}`);

  const h = headers(session);
  const pid = encodeURIComponent(patient.id);

  // Try a wide grid of candidate endpoints. We're looking for one that
  // returns "Life Length Telomere Test" with a Dec 17 2025 date.
  await probe("labresults (consultant)",
    `${PB_BASE}/api/consultant/labresults?limit=200&records=${pid}`, h);
  await probe("documents (consultant)",
    `${PB_BASE}/api/consultant/documents?limit=200&records=${pid}`, h);
  await probe("files (consultant)",
    `${PB_BASE}/api/consultant/files?limit=200&records=${pid}`, h);
  await probe("labs (consultant)",
    `${PB_BASE}/api/consultant/labs?limit=200&records=${pid}`, h);
  await probe("clientrecords/<id>/labs",
    `${PB_BASE}/api/consultant/clientrecords/${pid}/labs?limit=200`, h);
  await probe("clientrecords/<id>/labresults",
    `${PB_BASE}/api/consultant/clientrecords/${pid}/labresults?limit=200`, h);
  await probe("clientrecords/<id>/files",
    `${PB_BASE}/api/consultant/clientrecords/${pid}/files?limit=200`, h);
  await probe("clientrecords/<id>/documents",
    `${PB_BASE}/api/consultant/clientrecords/${pid}/documents?limit=200`, h);
  await probe("documents (consultant, no records=)",
    `${PB_BASE}/api/consultant/documents?limit=50`, h);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
