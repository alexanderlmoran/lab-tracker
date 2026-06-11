// Find the working (endpoint, x-api-version) combo for the session-note TEMPLATE
// catalog. Note-detail works at 5.1 but the templates list 425s there — try
// other versions/paths. Read-only; prints status + count only.
//
// Run:  cd worker && npx tsx scripts/pb-templates-versionsweep.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE, type PbSession } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;

const PATHS = [
  "/api/consultant/sessionnotetemplates?limit=500",
  "/api/consultant/sessionnotetemplates?limit=500&sort=name",
  "/api/consultant/notetemplates?limit=500",
  "/api/consultant/templates?limit=500",
  "/api/company/administration/sessionnotetemplates?limit=500",
];
const VERSIONS = ["5.1", "5.2", "5.3", "5.0", "6.0", "4.0", "3.0", "2.0", "1.0", ""];

async function tryOne(s: PbSession, path: string, ver: string) {
  const headers: Record<string, string> = { ...pbApiHeaders(s), accept: "application/json, text/plain, */*" };
  if (ver) headers["x-api-version"] = ver;
  const res = await pbRequest(`${PB_BASE}${path}`, { method: "GET", headers });
  let count = "";
  if (res.statusCode === 200) {
    try { const j: any = JSON.parse(await res.body.text()); const arr = Array.isArray(j) ? j : (j.items ?? j.data ?? []); count = `count=${arr.length}`; }
    catch { count = "non-json"; await res.body.text().catch(() => {}); }
  } else { await res.body.text().catch(() => {}); }
  return { path: path.split("?")[0], ver: ver || "(none)", status: res.statusCode, count };
}

async function main() {
  const s = await pbLogin(U, P);
  console.log("✓ logged in\n");
  for (const path of PATHS) {
    for (const ver of VERSIONS) {
      try {
        const r = await tryOne(s, path, ver);
        const mark = r.status === 200 ? "  ✅" : "";
        console.log(`${String(r.status).padEnd(4)} v=${r.ver.padEnd(7)} ${r.path} ${r.count}${mark}`);
        if (r.status === 200) return; // found it
      } catch (e) { console.log(`ERR  v=${ver} ${path}: ${e instanceof Error ? e.message.slice(0, 60) : e}`); }
    }
  }
  console.log("\n(no 200 found — fall back to reference-note scaffolds per template)");
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
