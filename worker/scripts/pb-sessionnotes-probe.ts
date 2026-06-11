// READ-ONLY probe of PB's session-note API, server-side (clean residential IP →
// no browser 425, no proxy needed locally). Confirms the worker can read the
// template catalog + a template's question structure + a note's content shape,
// which is everything needed to build the create payload.
//
// Run:  cd worker && npx tsx scripts/pb-sessionnotes-probe.ts
//
// Prints STRUCTURE only — template names/ids (not PHI) and the note's field
// schema with values redacted.

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
const NOTE = "6a272b54271793958adbbdc2"; // Infusion #29 (PC) — a filled IV note

const STRUCT = new Set([
  "id", "type", "fieldType", "kind", "label", "name", "key", "title", "object",
  "order", "rank", "required", "placeholder", "inputType", "control",
  "componentType", "isHeader", "level", "rowHeader", "columns", "rows",
]);
function red(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === "string") return v.length <= 48 ? v : `<str:${v.length}>`;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return typeof v;
}
function prune(v: unknown, d: number): unknown {
  if (Array.isArray(v)) return d <= 0 ? `[arr${v.length}]` : v.slice(0, 6).map((x) => prune(x, d - 1));
  if (v && typeof v === "object") {
    if (d <= 0) return `{${Object.keys(v as object).slice(0, 12).join(",")}}`;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).slice(0, 30)) {
      const val = (v as Record<string, unknown>)[k];
      if (/value|answer|text|content|html|body|response/i.test(k) && !STRUCT.has(k))
        o[k] = val && typeof val === "object" ? prune(val, d - 1) : red(val);
      else o[k] = prune(val, d - 1);
    }
    return o;
  }
  return red(v);
}

async function getJson(session: PbSession, path: string) {
  const res = await pbRequest(`${PB_BASE}${path}`, {
    method: "GET",
    headers: { ...pbApiHeaders(session), "x-api-version": "5.1", accept: "application/json, text/plain, */*" },
  });
  const text = await res.body.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
  return { status: res.statusCode, json };
}

async function main() {
  const session = await pbLogin(U!, P!);
  console.log(`✓ logged in (company=${session.companyId.slice(0, 6)}…, session set)\n`);

  // 1) Template catalog
  const tmpl = await getJson(session, "/api/consultant/sessionnotetemplates?limit=500");
  console.log(`templates GET → ${tmpl.status}`);
  const arr: any[] = Array.isArray(tmpl.json)
    ? tmpl.json
    : ((tmpl.json as any)?.items ?? (tmpl.json as any)?.data ?? []);
  console.log(`template count: ${arr.length}`);
  if (arr[0]) console.log(`template item keys: ${Object.keys(arr[0]).join(", ")}`);
  const iv = arr.filter((x) => /^iv |infus|phosphat|glutath|myers|ebo|methylene|weber|vitamin|cocktail|warrior|brain|nr |curcumin|chelat|athletic|signature|luma|beauty|regenesis/i.test(String(x.name ?? x.title ?? "")));
  console.log(`\nIV-ish templates (${iv.length}):`);
  for (const t of iv.slice(0, 50)) console.log(`  ${t.id}  ::  ${t.name ?? t.title}`);

  // 2) One IV template's full structure (questions)
  const probe = iv.find((x) => /immune boost|myers|high-dose vitamin c/i.test(String(x.name ?? x.title ?? ""))) ?? iv[0];
  if (probe) {
    console.log(`\n— template DETAIL for "${probe.name ?? probe.title}" (${probe.id}) —`);
    const td = await getJson(session, `/api/consultant/sessionnotetemplates/${probe.id}`);
    console.log(`  detail GET → ${td.status}`);
    console.log(JSON.stringify(prune(td.json, 7), null, 1));
  }

  // 3) An existing note's content shape (cross-check create target)
  console.log(`\n— note DETAIL ${NOTE} (structure, values redacted) —`);
  const nd = await getJson(session, `/api/consultant/sessionnotes/${NOTE}`);
  console.log(`  note GET → ${nd.status}`);
  const j: any = nd.json;
  console.log(JSON.stringify({ topKeys: j && typeof j === "object" ? Object.keys(j) : j, content: prune(j?.content, 7) }, null, 1));
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
