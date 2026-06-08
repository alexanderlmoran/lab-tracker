// One-shot cleanup: supersede the stale Vibrant "error / not-ready" PDFs left on
// cards (e.g. JAMES FRANGI shows "An error Occurs… 500 …REPORT_TYPE_…_NOT_EXIST").
//
// Why these exist: Vibrant's PDF engine returns the requested report as an error
// PAGE (HTTP 200) when the section format is wrong. The OLD scraper comma-joined
// the section codes (sections=OAC,OSU,CDZ) → a ~24 KB rendered error page that
// slipped past the scraper's <10 KB size guard and got staged. The current code
// requests a single section (sections=OAC) → an 879 B error the guard now rejects,
// so NO new bad cards are created — but the old ~24 KB pages are still attached.
// (NOTE: neither format actually downloads a real report yet — the correct
// multi-section URL is still unknown; that's the "Vibrant multi-section" TASKS
// item. This script only cleans up the error attachments.)
//
// Unlike a Wrong-PDF disapproval, this does NOT blank lab_external_ref or touch
// dismissed_refs: the accession is CORRECT (the order exists), it was just an
// error page. We only supersede the bad attachment so the card returns to "keep
// searching" and the scraper re-checks that accession later.
//
// Detection (self-justifying — it reads the actual page text, not just size):
//   • size < 10 KB                              → error page (fast path)
//   • else extract text via `pdftotext` and match a Vibrant error marker
//   • pdftotext missing → fall back to size < 50 KB (no real Vibrant report is
//     remotely that small; all 23 observed Vibrant PDFs are ≤ 26.5 KB error pages)
//
//   cd worker
//   npx tsx scripts/sweep-vibrant-bad-pdfs.ts            # DRY RUN — lists scope, writes nothing
//   npx tsx scripts/sweep-vibrant-bad-pdfs.ts --apply    # supersede the flagged PDFs

import { request } from "undici";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!SB || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY required");

const APPLY = process.argv.includes("--apply");
const SIZE_FLOOR = 10_000; // mirrors vibrant.ts downloadPdf() guard
const FALLBACK_FLOOR = 50_000; // used only if pdftotext is unavailable
const BUCKET = "lab-pdfs";
const ERROR_RE = /NOT_EXIST|An error Occur|REPORT_TYPE_/i;

type PdfRow = {
  id: string;
  case_id: string;
  source: string | null;
  size_bytes: number | null;
  filename: string | null;
  storage_path: string;
};

async function sb<T>(path: string, init: Parameters<typeof request>[1] = {}): Promise<T> {
  const res = await request(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY!, authorization: `Bearer ${KEY!}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.statusCode >= 300) {
    throw new Error(`supabase ${init.method ?? "GET"} ${path} -> ${res.statusCode}: ${(await res.body.text()).slice(0, 300)}`);
  }
  const text = await res.body.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function downloadObject(storagePath: string): Promise<Buffer | null> {
  const res = await request(`${SB}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: "GET",
    headers: { apikey: KEY!, authorization: `Bearer ${KEY!}` },
  });
  if (res.statusCode !== 200) {
    await res.body.text();
    return null;
  }
  return Buffer.from(await res.body.arrayBuffer());
}

let pdftotextOk: boolean | null = null;
function havePdftotext(): boolean {
  if (pdftotextOk !== null) return pdftotextOk;
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    pdftotextOk = true;
  } catch {
    pdftotextOk = false;
  }
  return pdftotextOk;
}

function pdfText(buf: Buffer): string | null {
  if (!havePdftotext()) return null;
  const tmp = join(tmpdir(), `vibsweep_${process.pid}_${Math.abs(buf.length)}.pdf`);
  try {
    writeFileSync(tmp, buf);
    return execFileSync("pdftotext", ["-l", "1", tmp, "-"], { encoding: "utf8" });
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// Returns a reason string if the PDF is a Vibrant error page, else null.
async function classify(p: PdfRow): Promise<string | null> {
  if (p.size_bytes !== null && p.size_bytes < SIZE_FLOOR) return `tiny error page (${p.size_bytes}B)`;
  const buf = await downloadObject(p.storage_path);
  if (!buf) return null; // can't read → leave it alone
  const txt = pdfText(buf);
  if (txt !== null) {
    const m = txt.match(ERROR_RE);
    return m ? `error page: "${m[0]}" (${buf.length}B)` : null;
  }
  // No pdftotext → conservative size fallback.
  return buf.length < FALLBACK_FLOOR ? `small (${buf.length}B), pdftotext unavailable` : null;
}

async function main() {
  console.log(APPLY ? "=== APPLY — superseding flagged PDFs ===\n" : "=== DRY RUN — nothing will be written ===\n");

  // Match by FILENAME (vibrant_*), not source — reconcile-staged copies have
  // source="engine:reconcile" and would be missed by a source filter.
  const pdfs = await sb<PdfRow[]>(
    "lab_case_pdfs?select=id,case_id,source,size_bytes,filename,storage_path" +
      "&superseded_at=is.null&filename=ilike.vibrant_*&order=size_bytes.desc.nullslast",
  );
  console.log(`Non-superseded Vibrant PDFs: ${pdfs.length}`);

  const caseIds = Array.from(new Set(pdfs.map((p) => p.case_id)));
  const cases = caseIds.length
    ? await sb<Array<{ id: string; patient_name: string; lab_name: string | null; step5_complete_uploaded: boolean }>>(
        `lab_cases?select=id,patient_name,lab_name,step5_complete_uploaded&id=in.(${caseIds.join(",")})`,
      )
    : [];
  const caseById = new Map(cases.map((c) => [c.id, c]));

  const flagged: Array<{ p: PdfRow; reason: string }> = [];
  for (const p of pdfs) {
    const reason = await classify(p);
    if (reason) flagged.push({ p, reason });
  }

  if (flagged.length === 0) {
    console.log("\nNo bad Vibrant PDFs found. Nothing to do.");
    return;
  }

  console.log(`\nFlagged BAD: ${flagged.length}`);
  for (const { p, reason } of flagged) {
    const c = caseById.get(p.case_id);
    const done = c?.step5_complete_uploaded ? " [step5✓]" : "";
    console.log(
      `  ${(c?.patient_name ?? p.case_id).padEnd(24)} ${String(p.source).padEnd(16)} ${reason}${done}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — re-run with --apply to supersede these ${flagged.length} attachment(s).`);
    return;
  }

  const now = new Date().toISOString();
  let ok = 0;
  for (const { p, reason } of flagged) {
    await sb(`lab_case_pdfs?id=eq.${p.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        superseded_at: now,
        superseded_reason: `auto-sweep: Vibrant error/not-ready page — ${reason}`,
      }),
    });
    await sb("lab_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        case_id: p.case_id,
        kind: "case_edited",
        actor: "admin:vibrant-sweep",
        note: `Superseded stale Vibrant error PDF (${reason}); accession kept so the scraper re-checks when ready`,
      }),
    });
    ok++;
  }
  console.log(`\nSuperseded ${ok}/${flagged.length} bad Vibrant PDF(s). Cards return to "keep searching".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
