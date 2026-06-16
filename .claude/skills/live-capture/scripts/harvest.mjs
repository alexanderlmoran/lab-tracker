#!/usr/bin/env node
// Harvest a live-Chrome network capture into a PHI-safe portal API map.
//
// Input: a JSON file (the dumped `window.__ccCap` array from the injected
//   interceptor — see SKILL.md). Each entry: {url, method, reqHeaders, reqBody,
//   status, respHeaders, respBody, ...}.
// Output: per-host files under the corpus dir, keyed by "METHOD /path", each
//   holding header NAMES (secret values masked), request/response SCHEMAS (field
//   names + types + a redacted sample), counts and first/last-seen. Raw bodies
//   are NEVER written — only shapes. This is what you need to build a scraper
//   without hoarding patient data or tokens.
//
// Usage: node harvest.mjs <capture.json> [corpusDir]
//   corpusDir defaults to worker/captures/live-api-map (gitignored).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const inPath = process.argv[2];
const corpusDir = process.argv[3] || "worker/captures/live-api-map";
if (!inPath) { console.error("usage: node harvest.mjs <capture.json> [corpusDir]"); process.exit(1); }

const SECRET_HEADER = /^(authorization|cookie|set-cookie|x-xsrf-token|x-csrf-token|x-csrf|x-api-key|api-key|apikey|x-session-id|x-auth-token|x-access-token|proxy-authorization)$/i;
// Field names whose VALUES are PII/PHI or secrets → never store a sample.
const SENSITIVE_KEY = /(pass|token|secret|auth|cookie|ssn|social|dob|birth|email|phone|mobile|firstname|lastname|fullname|\bname\b|address|street|zip|postal|mrn|insurance|policy|guardian|emergency)/i;

const maskHeaders = (h) => {
  const o = {};
  for (const k of Object.keys(h || {})) {
    const v = String(h[k] ?? "");
    o[k] = SECRET_HEADER.test(k) ? "«present, masked»" : v.length > 48 ? v.slice(0, 48) + "…" : v;
  }
  return o;
};

// Reduce a value to a SHAPE: object→{key:shape}, array→[elemShape], primitive→
// its type, with a short redacted sample for non-sensitive leaf strings so enum
// values survive without leaking PHI.
function shape(v, key = "", depth = 0) {
  if (depth > 6) return "…";
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0], key, depth + 1)] : [];
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).slice(0, 60)) o[k] = shape(v[k], k, depth + 1);
    return o;
  }
  const t = typeof v;
  if (t === "string") return SENSITIVE_KEY.test(key) ? "string«redacted»" : `string«${v.slice(0, 20)}»`;
  return t; // number | boolean
}

const bodyShape = (raw) => {
  if (raw == null || raw === "") return null;
  try { return shape(JSON.parse(raw)); } catch { return `«${typeof raw === "string" ? raw.length : "?"} chars non-JSON»`; }
};

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|js|map|ico|mp4|m4s)(\?|$)/i;
const isApiish = (e) => {
  if (!e || !e.url) return false;
  if (SKIP_EXT.test(e.url)) return false;
  const ct = (e.respHeaders && (e.respHeaders["content-type"] || e.respHeaders["Content-Type"])) || "";
  return e.kind === "fetch" || e.kind === "xhr" || /\/api\//.test(e.url) || /json/i.test(ct);
};

const now = new Date().toISOString();
let entries;
try { entries = JSON.parse(readFileSync(inPath, "utf8")); } catch (e) { console.error("bad capture json:", e.message); process.exit(1); }
if (!Array.isArray(entries)) { console.error("capture must be a JSON array"); process.exit(1); }

if (!existsSync(corpusDir)) mkdirSync(corpusDir, { recursive: true });
const byHost = new Map();
let kept = 0, skipped = 0;

for (const e of entries) {
  if (!isApiish(e)) { skipped++; continue; }
  let u;
  try { u = new URL(e.url, "https://x"); } catch { skipped++; continue; }
  const host = u.host || "unknown";
  const path = u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id"); // collapse numeric ids
  const epKey = `${(e.method || "GET").toUpperCase()} ${path}`;
  if (!byHost.has(host)) {
    const f = join(corpusDir, host.replace(/[^\w.-]/g, "_") + ".json");
    byHost.set(host, { f, data: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { host, endpoints: {} } });
  }
  const eps = byHost.get(host).data.endpoints;
  const ep = (eps[epKey] ??= { method: (e.method || "GET").toUpperCase(), path, count: 0, firstSeen: now, lastSeen: now, statuses: [], requestHeaders: {}, requestSchema: null, responseSchema: null });
  ep.count++; ep.lastSeen = now;
  if (e.status != null && !ep.statuses.includes(e.status)) ep.statuses.push(e.status);
  ep.requestHeaders = { ...ep.requestHeaders, ...maskHeaders(e.reqHeaders) };
  const rs = bodyShape(e.reqBody); if (rs && !ep.requestSchema) ep.requestSchema = rs;
  const ps = bodyShape(e.respBody); if (ps && !ep.responseSchema) ep.responseSchema = ps;
  if (u.search) ep.queryKeys = [...new Set([...(ep.queryKeys || []), ...u.searchParams.keys()])];
  kept++;
}

for (const { f, data } of byHost.values()) writeFileSync(f, JSON.stringify(data, null, 2));
console.log(`harvested ${kept} API call(s) (${skipped} skipped) → ${byHost.size} host file(s) in ${corpusDir}`);
for (const [host, { data }] of byHost) console.log(`  ${host}: ${Object.keys(data.endpoints).length} endpoint(s)`);
