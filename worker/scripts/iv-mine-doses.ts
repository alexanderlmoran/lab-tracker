// Mine the modal Standard Dose per IV component from historical PB session notes,
// so component-doses.ts can auto-fill the dose column on posted notes (the
// empty-dose bug: templates leave the dose column blank; staff enter it per
// visit, and the modal value is the de-facto standard).
//
// The dose lives in the ANSWER cells (not the template), keyed by the FULL
// normalized row label (which carries the concentration), so the printed map
// matches standardDoseFor(row.label) at fill time. Reads only — prints a TS map
// ready to paste into worker/src/iv/component-doses.ts.
//
// Run: cd worker && npx tsx scripts/iv-mine-doses.ts
//   IV_MINE_PATIENTS="Name A,Name B" npx tsx scripts/iv-mine-doses.ts

import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin, findPbPatient } from "../src/uploaders/practicebetter.js";
import { listSessionNotes, getSessionNote } from "../src/uploaders/pb-sessionnotes.js";

loadEnvLocal();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IV_RE = /iv|infusion|myers|immune|chelation|ebo|curcumin|brain|glutath|push|phosphatidyl|nad|hydrat|chelat|vitamin/i;

// Known recent IV patients (board + held review). Override with IV_MINE_PATIENTS.
const PATIENTS = (process.env.IV_MINE_PATIENTS ??
  [
    "Jenny Dashevsky", "Keisha Lightbourne", "Sasha Lightbourne", "Galina Buratti",
    "Yi Song", "Anastasia Romanova", "Catharine Arnston", "Lidia Alvarez",
    "Emilia Mineeva", "David Centner", "Leila Centner",
  ].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const NOTES_PER_PATIENT = Number(process.env.IV_MINE_NOTES ?? "12");
const log = (m: string) => console.log(m);

type Q = { object?: string; title?: string; columns?: Array<{ label?: string }>; rows?: Array<{ label?: string }> };

/** The Standard-Dose column index: prefer "standard dose", else a "dose" that
 *  isn't "add-on", else the first "dose" column. -1 if none. */
function stdDoseCol(cols: Array<{ label?: string }>): number {
  const L = cols.map((c) => (c.label ?? "").toLowerCase());
  let i = L.findIndex((l) => /standard dose/.test(l));
  if (i >= 0) return i;
  i = L.findIndex((l) => /dose/.test(l) && !/add.?on/.test(l));
  return i;
}

async function main() {
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  // label -> dose value -> count
  const tally = new Map<string, Map<string, number>>();
  let notesSeen = 0;

  for (const name of PATIENTS) {
    let hit;
    try { hit = await findPbPatient(pb, name); } catch { hit = null; }
    if (!hit?.id) { log(`· ${name}: no PB client`); continue; }
    await sleep(300);
    let notes;
    try { notes = await listSessionNotes(pb, hit.id, 50); } catch (e) { log(`· ${name}: list failed`); continue; }
    const iv = (notes as Array<{ id: string; name?: string; title?: string }>)
      .filter((n) => IV_RE.test(n.name || n.title || ""))
      .slice(0, NOTES_PER_PATIENT);
    log(`· ${name}: ${iv.length} IV notes`);
    for (const n of iv) {
      await sleep(350); // throttle — PB rate-limits
      let full;
      try { full = await getSessionNote(pb, n.id); } catch { continue; }
      notesSeen++;
      for (const c of (full.content ?? []) as Array<{ question?: Q; answer?: { answers?: Array<{ index: number; cells?: Array<string | null> }> } }>) {
        const q = c.question;
        if (!q || q.object !== "matrix" || !q.columns) continue;
        const di = stdDoseCol(q.columns);
        if (di < 0) continue;
        const ans = c.answer?.answers ?? [];
        (q.rows ?? []).forEach((r, i) => {
          const dose = ans.find((a) => a.index === i)?.cells?.[di];
          const label = (r.label ?? "").trim();
          if (!label || !dose || !String(dose).trim()) return;
          const key = norm(label);
          const inner = tally.get(key) ?? new Map<string, number>();
          inner.set(String(dose).trim(), (inner.get(String(dose).trim()) ?? 0) + 1);
          tally.set(key, inner);
        });
      }
    }
  }

  log(`\n==== mined from ${notesSeen} notes, ${tally.size} distinct products ====\n`);
  // Modal dose per product, sorted by sample count desc.
  const rows = [...tally.entries()]
    .map(([label, counts]) => {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [dose, n] = sorted[0];
      const total = sorted.reduce((s, [, c]) => s + c, 0);
      return { label, dose, n, total, alts: sorted.slice(1, 3) };
    })
    .sort((a, b) => b.total - a.total);

  log("// Mined modal Standard Dose per product (paste into component-doses.ts RAW):");
  for (const r of rows) {
    const conf = r.n === r.total ? "" : ` (${r.n}/${r.total}${r.alts.length ? `, alts: ${r.alts.map(([d, c]) => `${d}×${c}`).join(", ")}` : ""})`;
    log(`  ${JSON.stringify(r.label)}: ${JSON.stringify(r.dose)},${conf ? ` //${conf}` : ""}`);
  }
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
