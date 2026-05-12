// Cross-step workflow triggers fired from server actions:
//   - Step 5 flips true → if ALL of the patient's active labs are at step 5,
//     send Nadia a single "all labs received" email with a confirm link.
//   - Step 6 flips true → email Allison the ROF proofread notice and
//     auto-tick step 9 (which we've relabeled to "ROF Allison email sent").
//
// Both triggers are best-effort: an email failure must never block the
// underlying step toggle. Callers should `await` so the event log captures
// the side-effects in order, but should not treat thrown errors as fatal.

import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { sendAllisonRofReview, sendNadiaAllReceived } from "@/lib/email/internal";
import type { LabCase } from "@/lib/types";

async function fetchActiveSiblings(
  db: ReturnType<typeof getSupabaseAdmin>,
  patientEmail: string,
): Promise<LabCase[]> {
  const { data } = await db
    .from("lab_cases")
    .select("*")
    .ilike("patient_email", patientEmail)
    .is("archived_at", null)
    .is("deleted_at", null);
  return (data ?? []) as LabCase[];
}

/** Call after step 5 (complete_uploaded) is set true for `caseId`. */
export async function maybeFireNadiaAllReceived(
  caseId: string,
  actor: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  const { data: row } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (!row) return;
  const self = row as LabCase;
  if (!self.step5_complete_uploaded) return;
  if (self.archived_at || self.deleted_at) return;

  const siblings = await fetchActiveSiblings(db, self.patient_email);
  if (siblings.length === 0) return;

  // Only fire when EVERY active lab for this patient is at step 5.
  const allDone = siblings.every((c) => c.step5_complete_uploaded);
  if (!allDone) return;

  // Skip if there's already an outstanding (unconfirmed) Nadia token on any
  // sibling — we only want one outreach email per "batch complete" moment.
  const hasOutstanding = siblings.some(
    (c) => c.nadia_confirm_token && !c.nadia_confirmed_at,
  );
  if (hasOutstanding) return;

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const siblingIds = siblings.map((c) => c.id);

  // Stamp every sibling with the same token so the click confirms the batch.
  await db
    .from("lab_cases")
    .update({
      nadia_confirm_token: token,
      nadia_confirm_sent_at: now,
      nadia_confirmed_at: null,
    })
    .in("id", siblingIds);

  const result = await sendNadiaAllReceived({ cases: siblings, token });

  await db.from("lab_events").insert(
    siblingIds.map((id) => ({
      case_id: id,
      kind: result.ok ? "email_sent" : "email_failed",
      actor,
      meta: {
        emailKind: "nadia_all_received",
        token,
        siblingCount: siblings.length,
        ...(result.ok ? {} : { error: result.error }),
      },
    })),
  );
}

/** Call after step 6 (rof_scheduled) is set true for `caseId`. */
export async function maybeFireAllisonRof(
  caseId: string,
  actor: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  const { data: row } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (!row) return;
  const self = row as LabCase;
  if (!self.step6_rof_scheduled) return;
  if (self.archived_at || self.deleted_at) return;

  // Don't re-fire if we've already emailed Allison for this case.
  if (self.allison_rof_emailed_at) {
    // Still backfill step 9 in case it was manually unchecked.
    if (!self.step9_sales_followup) {
      await db
        .from("lab_cases")
        .update({ step9_sales_followup: true })
        .eq("id", caseId);
    }
    return;
  }

  // Bundle every active lab for the patient — Allison proofreads the whole
  // packet, not one panel at a time.
  const siblings = await fetchActiveSiblings(db, self.patient_email);
  const patientCases = siblings.length > 0 ? siblings : [self];

  const result = await sendAllisonRofReview({ patientCases });

  const now = new Date().toISOString();
  await db
    .from("lab_cases")
    .update({
      allison_rof_emailed_at: now,
      step9_sales_followup: true,
    })
    .eq("id", caseId);

  await db.from("lab_events").insert([
    {
      case_id: caseId,
      kind: result.ok ? "email_sent" : "email_failed",
      actor,
      meta: {
        emailKind: "rof_allison",
        ...(result.ok ? {} : { error: result.error }),
      },
    },
    {
      case_id: caseId,
      kind: "step_toggled",
      step: 9,
      completed: true,
      actor,
      note: "Auto-completed when Allison ROF proofread email fired",
    },
  ]);
}
