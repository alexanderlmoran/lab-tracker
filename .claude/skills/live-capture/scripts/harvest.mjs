#!/usr/bin/env node
// Merge a DISTILLED portal API map (produced in-browser by scripts/distill.js)
// into the persistent corpus under worker/captures/live-api-map.
//
// Why distill in-browser (not harvest raw here): the raw network buffer carries
// session cookies / auth tokens, and the MCP layer BLOCKS that blob from crossing
// to the agent (a good safety backstop). So distill.js reduces each call to a
// PHI/auth-free shape (header NAMES only, body SCHEMAS, no values, no query
// strings) IN the page; only that clean map crosses. This script just unions it
// into the corpus across capture sessions.
//
// Input JSON: either the distill output `{hosts, map}` or a bare map
//   `{ "<host>": { "<METHOD /path>": {method,path,count,statuses,reqHeaderNames,
//   reqSchema,respSchema} } }`.
// Usage: node harvest.mjs <distilled.json> [corpusDir]
//   corpusDir defaults to worker/captures/live-api-map (gitignored).
//
// (Back-compat: a bare ARRAY input is treated as a raw capture and rejected with
// guidance — distill in the browser first.)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const inPath = process.argv[2];
const corpusDir = process.argv[3] || "worker/captures/live-api-map";
if (!inPath) { console.error("usage: node harvest.mjs <distilled.json> [corpusDir]"); process.exit(1); }

let input;
try { input = JSON.parse(readFileSync(inPath, "utf8")); } catch (e) { console.error("bad json:", e.message); process.exit(1); }
if (Array.isArray(input)) { console.error("got a raw capture array — distill it in the browser first (scripts/distill.js) so cookies/tokens never cross; this script merges the distilled map."); process.exit(1); }
const map = input.map ?? input;

if (!existsSync(corpusDir)) mkdirSync(corpusDir, { recursive: true });
const now = new Date().toISOString();
let hostCount = 0, epCount = 0;

for (const host of Object.keys(map)) {
  if (!host || host.startsWith("[")) continue; // skip harness-redacted host keys
  const f = join(corpusDir, host.replace(/[^\w.-]/g, "_") + ".json");
  const data = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { host, firstSeen: now, endpoints: {} };
  for (const [key, inc] of Object.entries(map[host])) {
    const ep = (data.endpoints[key] ??= { method: inc.method, path: inc.path, count: 0, firstSeen: now, statuses: [], reqHeaderNames: [], reqSchema: null, respSchema: null });
    ep.count += inc.count || 1;
    ep.lastSeen = now;
    for (const s of inc.statuses || []) if (!ep.statuses.includes(s)) ep.statuses.push(s);
    for (const h of inc.reqHeaderNames || []) if (!ep.reqHeaderNames.includes(h)) ep.reqHeaderNames.push(h);
    if (!ep.reqSchema && inc.reqSchema) ep.reqSchema = inc.reqSchema;
    if (!ep.respSchema && inc.respSchema) ep.respSchema = inc.respSchema;
    if (inc.queryKeys) ep.queryKeys = [...new Set([...(ep.queryKeys || []), ...inc.queryKeys])];
    epCount++;
  }
  data.lastSeen = now;
  writeFileSync(f, JSON.stringify(data, null, 2));
  hostCount++;
  console.log(`  ${host}: ${Object.keys(data.endpoints).length} endpoint(s) → ${f}`);
}
console.log(`merged ${epCount} endpoint hit(s) into ${hostCount} host file(s) in ${corpusDir}`);
