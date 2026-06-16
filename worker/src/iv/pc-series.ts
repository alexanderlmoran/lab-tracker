// Single source of truth for reading a patient's PC infusion count from PB to
// SEED the local ledger (iv_infusion_series) ONCE per patient. Used by BOTH the
// worker loop seed pass (scripts/iv-autopost-loop.ts) and the bootstrap CLI
// (scripts/iv-enrich-pc-history.ts) so the seed semantics can never drift.

import { searchPbPatientCandidates, type PbSession } from "../uploaders/practicebetter.js";
import { listSessionNotes } from "../uploaders/pb-sessionnotes.js";
import { parseInfusionTitle } from "./build-note-content.js";
import { pickBestMatch, type PatientIdentity } from "./match-patient.js";

export type PcSeed = { lastNumber: number | null; lastVials: string | null; reason: string };

/** Read a patient's current PC infusion count from PB. Returns:
 *   - lastNumber = their highest "Infusion #N" note (confident full-name match);
 *   - lastNumber = 0 when PB has NO record of them at all (genuinely new → #1);
 *   - lastNumber = null when PB HAS candidates but none confidently match (name
 *     not "full") — AMBIGUOUS, so DON'T seed: leave the patient unseeded and let
 *     the post hold for staff, who enter the real number (which then becomes
 *     authoritative and syncs the ledger). This avoids silently restarting an
 *     established patient at #1 under a slightly-different PB name. */
export async function readPbInfusionSeed(pb: PbSession, identity: PatientIdentity): Promise<PcSeed> {
  const cands = await searchPbPatientCandidates(pb, (identity.fullName || identity.email || "").trim());
  const best = pickBestMatch(identity, cands);
  if (!best || best.signals.name !== "full") {
    return cands.length
      ? { lastNumber: null, lastVials: null, reason: "PB candidates exist but no confident name match — skip seeding (staff sets #)" }
      : { lastNumber: 0, lastVials: null, reason: "no PB record — new patient, starts #1" };
  }
  const notes = await listSessionNotes(pb, best.candidate.id, 50);
  const pcs = notes
    .map((n) => ({ name: (n.name as string) ?? "", date: String((n as Record<string, unknown>).sessionDate ?? ""), p: parseInfusionTitle((n.name as string) ?? "") }))
    .filter((x) => x.p && /phosphatidylcholine/i.test(x.name))
    .sort((a, b) => b.date.localeCompare(a.date));
  const last = pcs[0]?.p ?? null;
  return last
    ? { lastNumber: last.number, lastVials: last.vials, reason: `last "#${last.number}${last.vials ? ` (${last.vials})` : ""}"` }
    : { lastNumber: 0, lastVials: null, reason: "matched, no prior PC note — starts #1" };
}
