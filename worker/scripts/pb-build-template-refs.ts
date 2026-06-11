// Scan PB session notes to propose a reference note per IV template (for
// iv_template_refs). The templates LIST 425s, so each template's scaffold comes
// from a real note; we match note NAME → the classifier's templateHint.
//
// Read-only. Prints proposed {hint → note} + ready-to-run SQL for HIGH-confidence
// (substring) matches. Fuzzy matches are flagged for human review (note names
// carry "(updated)" suffixes etc.).
//
// Run: cd worker && npx tsx scripts/pb-build-template-refs.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, pbApiHeaders, pbRequest, PB_BASE } from "../src/uploaders/practicebetter.js";

loadEnvLocal();
const U = process.env.PB_USERNAME!, P = process.env.PB_PASSWORD!;

// templateHints the classifier emits (PC + add-ons excluded: PC is seeded,
// add-ons append to a base note). Order is irrelevant.
const HINTS = [
  "EBOO Oxygenation & Ozone Therapy", "EBO2 Therapy", "Custom", "Immune Boost",
  "NR+ 250mg for Longevity & Mitochondrial Support", "Myers' Cocktail", "Wellness Warrior - Staff",
  "High-Dose Vitamin C (25g)", "Methylene Blue (10 mg)", "Weber",
  "NR+ 500mg for Longevity & Mitochondrial Support", "Athletic Performance",
  "Brain Boost & Cognitive Support", "Chelation + Weber", "Wellness Warrior",
  "Methylene Blue IV (20 mg)", "Signature Cocktail", "Luma Elite UVBI",
  "Wellness Warrior - Centner Academy", "High-Dose Vitamin C (50g)", "Curcumin 100mg",
  "EDTA", "DMPS", "Methylene Blue IV (30 mg)", "Regenesis Stack", "Beauty Boost Rejuvenation",
];

const clean = (s: string) => s.toLowerCase().replace(/\(updated\)/g, "").replace(/^iv\s*-\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => new Set(clean(s).split(" ").filter((t) => t.length > 2));

async function fetchConsultantNotes(session: Awaited<ReturnType<typeof pbLogin>>, limit: number) {
  // Try the consultant-wide list first (no records filter), like labrequests.
  const url = `${PB_BASE}/api/consultant/sessionnotes?limit=${limit}&sort=date_desc`;
  const res = await pbRequest(url, { method: "GET", headers: { ...pbApiHeaders(session), "x-api-version": "5.1", accept: "application/json, text/plain, */*" } });
  if (res.statusCode !== 200) return { status: res.statusCode, notes: [] as Array<{ id: string; name: string }> };
  const j = (await res.body.json()) as { items?: Array<{ id: string; name?: string }> } | Array<{ id: string; name?: string }>;
  const items = Array.isArray(j) ? j : j.items ?? [];
  return { status: 200, notes: items.map((n) => ({ id: n.id, name: n.name ?? "" })) };
}

async function main() {
  const s = await pbLogin(U, P);
  console.log("✓ logged in; fetching consultant notes…");
  const { status, notes } = await fetchConsultantNotes(s, 2000);
  console.log(`consultant-wide notes GET → ${status}, ${notes.length} notes`);
  if (status !== 200 || notes.length === 0) {
    console.log("consultant-wide list unavailable — fall back to scanning specific heavy-user patients via listSessionNotes(clientRecordId).");
    return;
  }

  // Index: first note id per distinct name (most recent, since sorted desc).
  const byName = new Map<string, { id: string; name: string }>();
  for (const n of notes) if (n.name && !byName.has(n.name)) byName.set(n.name, n);
  const ivNotes = [...byName.values()].filter((n) => /^iv\s*-|infusion|phosphat/i.test(n.name));
  console.log(`distinct IV-ish note names: ${ivNotes.length}\n`);

  const sqlRows: string[] = [];
  for (const hint of HINTS) {
    const ch = clean(hint);
    // High confidence: a note whose cleaned name contains the cleaned hint.
    let best = ivNotes.find((n) => clean(n.name).includes(ch));
    let conf = best ? "HIGH" : "";
    if (!best) {
      // Fallback: max token overlap.
      const ht = tokens(hint);
      let bestScore = 0;
      for (const n of ivNotes) {
        const nt = tokens(n.name);
        const overlap = [...ht].filter((t) => nt.has(t)).length;
        const ratio = overlap / Math.max(1, ht.size);
        if (overlap > bestScore && ratio >= 0.6) { bestScore = overlap; best = n; }
      }
      conf = best ? "fuzzy" : "NONE";
    }
    if (best) {
      console.log(`${conf.padEnd(5)} ${hint}\n        → "${best.name}"  (${best.id})`);
      if (conf === "HIGH") sqlRows.push(`('${hint.replace(/'/g, "''")}','${best.id}','auto: ${best.name.replace(/'/g, "''").slice(0, 40)}')`);
    } else {
      console.log(`NONE  ${hint}  → no matching note`);
    }
  }

  if (sqlRows.length) {
    console.log(`\n=== SQL to seed ${sqlRows.length} HIGH-confidence refs (review fuzzy/none manually) ===`);
    console.log(`insert into iv_template_refs (template_hint, reference_note_id, note) values\n${sqlRows.join(",\n")}\non conflict (template_hint) do update set reference_note_id=excluded.reference_note_id, note=excluded.note, updated_at=now();`);
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
