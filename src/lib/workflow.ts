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
import { Resend } from "resend";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { sendAllisonRofReview, sendNadiaAllReceived } from "@/lib/email/internal";
import { sendCompleteUploadNotice } from "@/lib/email/digests";
import { renderEmail } from "@/lib/email/render";
import { isEmailKindEnabled } from "@/lib/email/template-data";
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

  // The patient's group = all their active siblings. Split into received
  // (at step 5) and outstanding (not yet there) so the email reflects the
  // whole group's state, not just the one lab that flipped (backlog #12).
  const received = siblings.filter((c) => c.step5_complete_uploaded);
  const outstanding = siblings.filter((c) => !c.step5_complete_uploaded);

  // Only fire when EVERY active lab for this patient is at step 5 — outreach
  // shouldn't start mid-batch. The outstanding set is computed anyway so the
  // email body is correct if this gate is ever relaxed to fire earlier.
  if (outstanding.length > 0) {
    // VISIBILITY: the gate is correct, but staff couldn't tell WHY Nadia never
    // fired — the email was silently starved waiting on sibling labs. Emit a
    // visible signal (best-effort; never blocks). Deduped on the same
    // outstanding-count so we log once per change, not every step toggle.
    try {
      // Filter directly on the JSON flag so unrelated case_edited noise (other
      // notifications/edits) can't push the prior block event out of a fixed
      // window and defeat the dedup. Most-recent block for this case only.
      const { data: priorBlocks } = await db
        .from("lab_events")
        .select("meta")
        .eq("case_id", caseId)
        .eq("kind", "case_edited")
        .eq("meta->>nadia_all_received_blocked", "true")
        .order("created_at", { ascending: false })
        .limit(1);
      const lastBlock = (priorBlocks ?? [])[0] as
        | { meta: { outstandingCount?: number } | null }
        | undefined;
      if (lastBlock?.meta?.outstandingCount !== outstanding.length) {
        await db.from("lab_events").insert({
          case_id: caseId,
          kind: "case_edited",
          actor,
          meta: {
            nadia_all_received_blocked: true,
            outstandingCount: outstanding.length,
            receivedCount: received.length,
            outstandingLabs: outstanding.map((c) => c.lab_name),
          },
          note: `Nadia "all results received" blocked by ${outstanding.length} outstanding lab${
            outstanding.length === 1 ? "" : "s"
          } for ${self.patient_name} (${received.length}/${siblings.length} at step 5)`,
        });
      }
    } catch (err) {
      console.error("[workflow] nadia-blocked signal failed", err);
    }
    return;
  }

  // Skip if there's already an outstanding (unconfirmed) Nadia token on any
  // sibling — we only want one outreach email per "batch complete" moment.
  const hasOutstandingToken = siblings.some(
    (c) => c.nadia_confirm_token && !c.nadia_confirmed_at,
  );
  if (hasOutstandingToken) return;

  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 86_400_000);
  const siblingIds = siblings.map((c) => c.id).sort();

  // ATOMIC claim: the outstanding-token read above is check-then-act — two
  // concurrent invocations (two staff tabs, worker + UI) can both pass it and
  // both send. Claim the batch by stamping the LOCK row (smallest sibling id)
  // with a conditional update that only succeeds when no outstanding token
  // exists; the loser updates 0 rows and skips the send.
  const lockId = siblingIds[0];
  const stamp = {
    nadia_confirm_token: token,
    nadia_confirm_sent_at: now.toISOString(),
    nadia_confirm_expires_at: expires.toISOString(),
    nadia_confirmed_at: null,
  };
  const { data: claimed } = await db
    .from("lab_cases")
    .update(stamp)
    .eq("id", lockId)
    .or("nadia_confirm_token.is.null,nadia_confirmed_at.not.is.null")
    .select("id");
  if (!claimed || claimed.length === 0) return; // another invocation won the race

  // Stamp the rest of the batch with the same token so the click confirms the
  // whole group. 30-day expiry caps the blast radius of a stale link.
  const restIds = siblingIds.filter((id) => id !== lockId);
  if (restIds.length > 0) {
    await db.from("lab_cases").update(stamp).in("id", restIds);
  }

  const result = await sendNadiaAllReceived({
    cases: received,
    outstandingCases: outstanding,
    token,
  });

  await db.from("lab_events").insert(
    siblingIds.map((id) => ({
      case_id: id,
      kind: result.ok ? "email_sent" : "email_failed",
      actor,
      meta: {
        emailKind: "nadia_all_received",
        token,
        siblingCount: siblings.length,
        outstandingCount: outstanding.length,
        ...(result.ok ? {} : { error: result.error }),
      },
    })),
  );
}

/**
 * Backlog #21 — "complete upload notification." Call after step 5
 * (complete_uploaded) is set true for `caseId`. Sends ONE internal staff
 * notice that the result is now on PracticeBetter. Deduped on a per-case
 * `complete_upload_notified` lab_event flag (no schema change — same trick
 * the RoF-reminder cooldown uses) so the multiple step-5 flip paths and the
 * same-accession sibling cascade can each call it without double-notifying.
 * Best-effort: never blocks the underlying upload.
 */
export async function notifyCompleteUpload(
  caseId: string,
  actor: string,
  opts?: { pbLabRequestId?: string | null },
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

  // Dedupe: bail if we've already notified for this case.
  const { data: prior } = await db
    .from("lab_events")
    .select("id, meta")
    .eq("case_id", caseId)
    .eq("kind", "case_edited")
    .limit(50);
  const alreadyNotified = (prior ?? []).some(
    (e) => (e as { meta: { complete_upload_notified?: boolean } | null }).meta?.complete_upload_notified,
  );
  if (alreadyNotified) return;

  const result = await sendCompleteUploadNotice({
    patientCase: self,
    pbLabRequestId: opts?.pbLabRequestId ?? null,
  });

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "case_edited",
    actor,
    meta: {
      complete_upload_notified: true,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    },
    note: result.ok
      ? "Complete-upload notification emailed"
      : `Complete-upload notification failed: ${result.error}`,
  });
}

/**
 * Global kill-switch for auto-dispatching PATIENT-facing tracker emails on a
 * step flip. DEFAULT OFF: returns true only when the app_settings row
 * `auto_send_patient_emails` is explicitly "true" (or env
 * AUTO_SEND_PATIENT_EMAILS="true"). This is the safety gate that makes the
 * per-case `auto_send_emails` flag — which DB-defaults to true on every
 * existing/imported/worker-created case — safe to honor: without staff opting
 * in here, no historical step flip can blast a patient. Best-effort read; any
 * error → off.
 */
async function patientAutoSendGloballyEnabled(): Promise<boolean> {
  if ((process.env.AUTO_SEND_PATIENT_EMAILS ?? "").toLowerCase() === "true") {
    return true;
  }
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("key", "auto_send_patient_emails")
      .maybeSingle();
    return ((data?.value as string | null) ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * GATED auto-send of the patient `complete_uploaded` (Email 3) tracker email
 * when a case reaches step 5 via an automated path (the PB-upload worker).
 *
 * Wires the previously-vestigial per-case `auto_send_emails` flag WITHOUT
 * changing default behavior: dispatch happens ONLY when BOTH
 *   (a) the global kill-switch is explicitly on (default OFF), and
 *   (b) this case's `auto_send_emails` is true.
 * The manual "Send email" button (sendPatientEmail) is untouched.
 *
 * Reuses the existing email machinery — renderEmail (the shared renderer the
 * manual sender uses), the template-enabled check, the email_logs table, and
 * the same idempotency rule (skip if a prior sent/skipped row exists) — rather
 * than inventing a parallel path. It does NOT use sendPatientEmail directly:
 * that action calls requireSignedIn() and would redirect in the worker context
 * (no session). Best-effort: never blocks the upload.
 */
export async function maybeFireCompleteUploadedEmail(
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

  // Per-case opt-out + global default-off kill switch. Either OFF → no send.
  if (!self.auto_send_emails) return;
  if (!(await patientAutoSendGloballyEnabled())) return;
  if (!self.patient_email) return;

  const kind = "complete_uploaded" as const;

  // Idempotency (mirrors sendPatientEmail): if a prior sent/skipped row exists
  // for this kind, don't auto-send again — staff may have already sent it.
  const { data: priorLog } = await db
    .from("email_logs")
    .select("id")
    .eq("case_id", caseId)
    .eq("kind", kind)
    .in("status", ["sent", "skipped"])
    .limit(1);
  if (priorLog && priorLog.length > 0) return;

  // Honor the template "in use" toggle (same as dispatchEmail) — a disabled
  // template must not auto-send.
  if (!(await isEmailKindEnabled(kind))) return;

  const rendered = await renderEmail(self, kind);

  // Clear prior FAILED rows for this kind so the log doesn't accumulate dead
  // weight across retries — same housekeeping dispatchEmail does.
  await db
    .from("email_logs")
    .delete()
    .eq("case_id", caseId)
    .eq("kind", kind)
    .eq("status", "failed");

  const { data: queuedRow, error: insertErr } = await db
    .from("email_logs")
    .insert({ case_id: caseId, kind, status: "queued", to_address: rendered.originalTo })
    .select("id")
    .single();
  if (insertErr || !queuedRow) return;

  let messageId: string | undefined;
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from: rendered.from,
      to: rendered.to,
      bcc: rendered.bcc,
      replyTo: rendered.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result.error) throw new Error(result.error.message);
    messageId = result.data?.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed";
    await db.from("email_logs").update({ status: "failed", error_message: msg }).eq("id", queuedRow.id);
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "email_failed",
      actor,
      meta: { emailKind: kind, error: msg, autoSent: true },
    });
    return;
  }

  await db
    .from("email_logs")
    .update({ status: "sent", resend_message_id: messageId ?? null })
    .eq("id", queuedRow.id);
  await db.from("lab_events").insert({
    case_id: caseId,
    kind: "email_sent",
    actor,
    meta: { emailKind: kind, messageId, isTest: rendered.isTestRedirect, autoSent: true },
  });
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
