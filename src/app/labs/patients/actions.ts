"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * Merge two patient records (human-approved dedup from /labs/patients). Patients
 * are keyed by lab_cases.patient_email, so the merge re-keys the alias email's
 * cases onto the canonical email and records the move in patient_aliases (audit
 * + reversibility). Re-keying is the right call for the common case — a typo'd
 * domain (leila@centenr… → leila@centner…) — and PB/result identity is unaffected
 * (PB keys off its own chart, not the tracker email).
 */
export async function mergePatients(input: {
  aliasEmail: string;
  canonicalEmail: string;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const aliasLc = (input.aliasEmail ?? "").trim().toLowerCase();
  const canonical = (input.canonicalEmail ?? "").trim();
  if (!aliasLc || !canonical) return { ok: false, error: "Both emails are required." };
  if (aliasLc === canonical.toLowerCase()) {
    return { ok: false, error: "Pick two different patients to merge." };
  }

  const db = getSupabaseAdmin();

  // Re-key the alias email's cases onto the canonical email (case-insensitive
  // match; ilike with no % is an exact, case-insensitive compare).
  const { data: moved, error } = await db
    .from("lab_cases")
    .update({ patient_email: canonical })
    .ilike("patient_email", aliasLc)
    .select("id");
  if (error) return { ok: false, error: error.message };

  // Record the merge (best-effort; the re-key above is the load-bearing part).
  await db
    .from("patient_aliases")
    .upsert(
      { alias_email: aliasLc, canonical_email: canonical, merged_by: user.email ?? "staff" },
      { onConflict: "alias_email" },
    );

  if (moved?.length) {
    await db.from("lab_events").insert(
      moved.map((m) => ({
        case_id: m.id as string,
        kind: "case_edited" as const,
        actor: user.email ?? "staff",
        note: `Patient merged: ${aliasLc} → ${canonical}`,
        meta: { merged_from: aliasLc, merged_to: canonical },
      })),
    );
  }

  revalidatePath("/labs/patients");
  revalidatePath("/labs");
  return { ok: true };
}
