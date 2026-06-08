// Read-only audit: for every COMPLETE case (step5_complete_uploaded), verify the
// lab is genuinely on the patient's PB chart. Answers "is each Complete-Uploaded
// card really posted?" — covers the admin:backfill-brain "already on PB" advances
// AND the manual "already on PB" marks, neither of which uploaded a fresh PDF.
//
// How it matches (strongest signal wins):
//   STRONG  — the case's accession (lab_external_ref) appears in a PB labrequest name
//   LIKELY  — the vendor token (Access/Vibrant/…) is in a labrequest name AND the
//             order date is within 30 days of the case's collection_date
//   MISSING — patient found on PB but no matching labrequest  → needs eyeballs
//   NO MATCH— patient not found on PB at all                  → name/DOB mismatch
//
// It NEVER writes. Run it before lowering RECONCILE_AUTOPOST_THRESHOLD from 101→90.
//
//   cd worker
//   npx tsx scripts/audit-pb-coverage.ts            # all complete cases
//   npx tsx scripts/audit-pb-coverage.ts --missing  # only print MISSING / NO MATCH
//   npx tsx scripts/audit-pb-coverage.ts vibrant    # filter to one lab (substring)

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import {
  pbLogin,
  findPbPatient,
  listAllConsultantLabRequests,
  type PbLabRequest,
} from "../src/uploaders/practicebetter.js";

loadEnvLocal();

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!SB || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY required");
if (!process.env.PB_USERNAME || !process.env.PB_PASSWORD) {
  throw new Error("PB_USERNAME / PB_PASSWORD required");
}

const args = process.argv.slice(2);
const missingOnly = args.includes("--missing");
const labFilter = args.find((a) => !a.startsWith("--"))?.toLowerCase() ?? null;

type CompleteCase = {
  id: string;
  patient_name: string;
  patient_dob: string | null;
  lab_name: string | null;
  lab_external_ref: string | null;
  collection_date: string | null;
  archived_at: string | null;
};

async function sbGet<T>(path: string): Promise<T> {
  const res = await request(`${SB}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: KEY!, authorization: `Bearer ${KEY!}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(`supabase GET ${path} -> ${res.statusCode}: ${(await res.body.text()).slice(0, 300)}`);
  }
  return (await res.body.json()) as T;
}

// First word of the lab name, lowercased, alpha only: "Access Custom" → "access",
// "Vibrant · EBOO Waste" → "vibrant". PB titles are vendor-first so this is the
// token we expect to see in a labrequest name.
function labToken(labName: string | null): string {
  if (!labName) return "";
  const first = labName.trim().split(/[\s·—-]+/)[0] ?? "";
  return first.toLowerCase().replace(/[^a-z]/g, "");
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

type Verdict = "STRONG" | "LIKELY" | "MISSING" | "NO_MATCH";

function classify(c: CompleteCase, lrs: PbLabRequest[]): { verdict: Verdict; hit?: PbLabRequest } {
  const acc = (c.lab_external_ref ?? "").trim();
  if (acc) {
    const hit = lrs.find((lr) => (lr.name ?? "").includes(acc));
    if (hit) return { verdict: "STRONG", hit };
  }
  const token = labToken(c.lab_name);
  const likely = lrs.find((lr) => {
    const n = (lr.name ?? "").toLowerCase();
    if (token && !n.includes(token)) return false;
    const d = daysApart(lr.dateOrdered ?? null, c.collection_date);
    if (d !== null) return d <= 30;
    return token !== ""; // vendor matched, no date to compare → still a likely hit
  });
  if (likely) return { verdict: "LIKELY", hit: likely };
  return { verdict: "MISSING" };
}

async function main() {
  // 1. Pull every complete case (exclude deleted; include archived — "Completed"
  //    lane IS archived). PostgREST caps at 1000/req; the complete set is ~100.
  let q =
    "lab_cases?select=id,patient_name,patient_dob,lab_name,lab_external_ref,collection_date,archived_at" +
    "&step5_complete_uploaded=eq.true&deleted_at=is.null&order=patient_name.asc&limit=2000";
  let cases = await sbGet<CompleteCase[]>(q);
  if (labFilter) cases = cases.filter((c) => (c.lab_name ?? "").toLowerCase().includes(labFilter));
  console.log(`Complete cases to audit: ${cases.length}${labFilter ? ` (lab~"${labFilter}")` : ""}`);

  // 2. PB: login once, pull the whole roster once, then resolve each unique
  //    patient to a PB id (deduped so we don't search PB once per case).
  const session = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const allLrs = await listAllConsultantLabRequests(session, { limit: 2000 });
  console.log(`PB labrequests pulled: ${allLrs.length}\n`);

  const patientKey = (c: CompleteCase) => `${c.patient_name.trim().toLowerCase()}|${c.patient_dob ?? ""}`;
  const pbIdCache = new Map<string, string | null>();
  async function resolvePbId(c: CompleteCase): Promise<string | null> {
    const k = patientKey(c);
    if (pbIdCache.has(k)) return pbIdCache.get(k)!;
    let id: string | null = null;
    try {
      const p = await findPbPatient(session, c.patient_name, c.patient_dob ?? undefined);
      id = p?.id ?? null;
    } catch (e) {
      console.warn(`  ! PB search failed for ${c.patient_name}: ${e instanceof Error ? e.message : e}`);
    }
    pbIdCache.set(k, id);
    return id;
  }

  // 3. Classify each case.
  const rows: Array<{ c: CompleteCase; verdict: Verdict; detail: string }> = [];
  for (const c of cases) {
    const pbId = await resolvePbId(c);
    if (!pbId) {
      rows.push({ c, verdict: "NO_MATCH", detail: "patient not found on PB" });
      continue;
    }
    const lrs = allLrs.filter((lr) => lr.clientRecord?.id === pbId);
    const { verdict, hit } = classify(c, lrs);
    const detail =
      verdict === "STRONG" || verdict === "LIKELY"
        ? `${hit!.name}  (${(hit!.dateOrdered ?? "").slice(0, 10)})`
        : `${lrs.length} PB labreq(s), none match`;
    rows.push({ c, verdict, detail });
  }

  // 4. Report.
  const order: Verdict[] = ["MISSING", "NO_MATCH", "LIKELY", "STRONG"];
  const label = (v: Verdict) =>
    ({ STRONG: "✓ STRONG ", LIKELY: "✓ likely ", MISSING: "✗ MISSING", NO_MATCH: "? NOMATCH" }[v]);
  for (const v of order) {
    if (missingOnly && (v === "STRONG" || v === "LIKELY")) continue;
    const group = rows.filter((r) => r.verdict === v);
    if (group.length === 0) continue;
    console.log(`\n=== ${label(v)}  (${group.length}) ===`);
    for (const { c, detail } of group) {
      const acc = c.lab_external_ref ? ` acc#${c.lab_external_ref}` : "";
      console.log(
        `  ${c.patient_name.padEnd(26)} ${(c.lab_name ?? "").padEnd(16)}${acc.padEnd(16)}  ${detail}`,
      );
    }
  }

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  console.log(
    `\nSUMMARY  total=${rows.length}  ` +
      `STRONG=${count("STRONG")}  likely=${count("LIKELY")}  ` +
      `MISSING=${count("MISSING")}  NO_MATCH=${count("NO_MATCH")}`,
  );
  console.log(
    "\nMISSING / NO_MATCH are the ones to eyeball in PB. STRONG = accession matched on chart.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
