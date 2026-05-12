"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Resend } from "resend";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { renderEmail } from "@/lib/email/render";
import { EMAIL_TO_STEP } from "@/lib/email/step-map";
import { maybeFireNadiaAllReceived } from "@/lib/workflow";
import type { ActionResult, EmailKind, EmailLog, LabCase } from "@/lib/types";

async function fireDownstream(kind: EmailKind, caseId: string, actor: string) {
  // Step 5 (complete_uploaded) is the only patient-email step that has a
  // downstream internal trigger. Best-effort — failures stay in the log.
  if (kind !== "complete_uploaded") return;
  try {
    await maybeFireNadiaAllReceived(caseId, actor);
  } catch (err) {
    console.error("[workflow] nadia trigger failed", err);
  }
}

const Kind = z.enum([
  "sample_sent",
  "partial_uploaded",
  "complete_uploaded",
  "rof_followup",
]);

const SendInput = z.object({
  caseId: z.string().uuid(),
  kind: Kind,
  alsoMarkStep: z.boolean().default(true),
});

const SkipInput = z.object({
  caseId: z.string().uuid(),
  kind: Kind,
});

const RetryInput = z.object({
  caseId: z.string().uuid(),
  kind: Kind,
});

const ResendInput = z.object({
  caseId: z.string().uuid(),
  kind: Kind,
});

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

async function fetchCase(caseId: string): Promise<LabCase | null> {
  const db = getSupabaseAdmin();
  const { data } = await db.from("lab_cases").select("*").eq("id", caseId).maybeSingle();
  return (data as LabCase | null) ?? null;
}

async function setStepBoolean(caseId: string, step: number) {
  const db = getSupabaseAdmin();
  const colMap: Record<number, string> = {
    1: "step1_sample_sent",
    3: "step3_partial_uploaded",
    5: "step5_complete_uploaded",
    7: "step7_rof_completed",
  };
  const col = colMap[step];
  if (!col) return;
  await db.from("lab_cases").update({ [col]: true }).eq("id", caseId);
}

async function findLatestSendOrSkip(caseId: string, kind: EmailKind) {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("email_logs")
    .select("id, status, created_at, resend_message_id")
    .eq("case_id", caseId)
    .eq("kind", kind)
    .in("status", ["sent", "skipped"])
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] ?? null) as
    | { id: string; status: "sent" | "skipped"; created_at: string; resend_message_id: string | null }
    | null;
}

/** Insert a fresh log row, dispatch via Resend, mark sent. Internal core. */
async function dispatchEmail(args: {
  caseId: string;
  kind: EmailKind;
  actor: string;
  resentEvent: boolean;
}): Promise<ActionResult<{ messageId?: string }>> {
  const { caseId, kind, actor, resentEvent } = args;
  const row = await fetchCase(caseId);
  if (!row) return { ok: false, error: "Case not found" };

  const db = getSupabaseAdmin();
  const rendered = await renderEmail(row, kind);

  // Always clear prior FAILED rows so the table doesn't accumulate dead weight.
  await db
    .from("email_logs")
    .delete()
    .eq("case_id", caseId)
    .eq("kind", kind)
    .eq("status", "failed");

  // Insert a new queued row. Unique constraint is gone — multiple sends accumulate.
  const { data: queuedRow, error: insertErr } = await db
    .from("email_logs")
    .insert({
      case_id: caseId,
      kind,
      status: "queued",
      to_address: rendered.originalTo,
    })
    .select("id")
    .single();

  if (insertErr || !queuedRow) {
    return { ok: false, error: insertErr?.message ?? "Could not log send" };
  }

  let messageId: string | undefined;
  try {
    const resend = getResend();
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
    await db
      .from("email_logs")
      .update({ status: "failed", error_message: msg })
      .eq("id", queuedRow.id);
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "email_failed",
      actor,
      meta: { emailKind: kind, error: msg, resent: resentEvent },
    });
    return { ok: false, error: msg };
  }

  await db
    .from("email_logs")
    .update({ status: "sent", resend_message_id: messageId ?? null })
    .eq("id", queuedRow.id);

  await db.from("lab_events").insert({
    case_id: caseId,
    kind: resentEvent ? "email_resent" : "email_sent",
    actor,
    meta: { emailKind: kind, messageId, isTest: rendered.isTestRedirect },
  });

  return { ok: true, data: { messageId } };
}

export async function sendPatientEmail(input: {
  caseId: string;
  kind: EmailKind;
  alsoMarkStep?: boolean;
}): Promise<ActionResult<{ messageId?: string; alreadySent?: boolean }>> {
  const user = await requireSignedIn();
  const parsed = SendInput.safeParse({
    caseId: input.caseId,
    kind: input.kind,
    alsoMarkStep: input.alsoMarkStep ?? true,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, kind, alsoMarkStep } = parsed.data;

  // Idempotency: if a prior `sent` or `skipped` row exists, do not re-send
  // automatically. Backfill the step boolean (in case it was manually
  // unchecked) and return alreadySent so the UI can render a Resend prompt.
  const prior = await findLatestSendOrSkip(caseId, kind);
  if (prior) {
    if (alsoMarkStep) {
      const step = EMAIL_TO_STEP[kind];
      await setStepBoolean(caseId, step);
      revalidatePath("/labs");
      revalidatePath(`/labs/${caseId}`);
    }
    return { ok: true, data: { alreadySent: true } };
  }

  const dispatch = await dispatchEmail({
    caseId,
    kind,
    actor: user.email ?? "admin",
    resentEvent: false,
  });
  if (!dispatch.ok) return dispatch;

  if (alsoMarkStep) {
    const step = EMAIL_TO_STEP[kind];
    await setStepBoolean(caseId, step);
    const db = getSupabaseAdmin();
    await db.from("lab_events").insert({
      case_id: caseId,
      kind: "step_toggled",
      step,
      completed: true,
      actor: user.email ?? "admin",
    });
  }

  await fireDownstream(kind, caseId, user.email ?? "admin");

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true, data: { messageId: dispatch.data?.messageId } };
}

/** Explicit user-triggered re-send. Bypasses the alreadySent short-circuit. */
export async function resendPatientEmail(input: {
  caseId: string;
  kind: EmailKind;
}): Promise<ActionResult<{ messageId?: string }>> {
  const user = await requireSignedIn();
  const parsed = ResendInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, kind } = parsed.data;

  const dispatch = await dispatchEmail({
    caseId,
    kind,
    actor: user.email ?? "admin",
    resentEvent: true,
  });
  if (!dispatch.ok) return dispatch;

  // Resend doesn't toggle the step (which is already true) — but if it was
  // manually unchecked, backfill so kanban stays in sync.
  const step = EMAIL_TO_STEP[kind];
  await setStepBoolean(caseId, step);

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true, data: { messageId: dispatch.data?.messageId } };
}

export async function skipPatientEmail(input: {
  caseId: string;
  kind: EmailKind;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = SkipInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, kind } = parsed.data;
  const db = getSupabaseAdmin();

  const prior = await findLatestSendOrSkip(caseId, kind);
  if (!prior) {
    const { error } = await db.from("email_logs").insert({
      case_id: caseId,
      kind,
      status: "skipped",
      to_address: "skipped",
    });
    if (error) return { ok: false, error: error.message };
  }

  const step = EMAIL_TO_STEP[kind];
  await setStepBoolean(caseId, step);

  await db.from("lab_events").insert([
    {
      case_id: caseId,
      kind: "email_skipped",
      actor: user.email ?? "admin",
      meta: { emailKind: kind },
    },
    {
      case_id: caseId,
      kind: "step_toggled",
      step,
      completed: true,
      actor: user.email ?? "admin",
    },
  ]);

  // Skipped patient email still advances the workflow — Nadia outreach
  // should fire when the step is marked done, regardless of how it got there.
  await fireDownstream(kind, caseId, user.email ?? "admin");

  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

/** Retry after a failed send. Treats the failed row as discardable. */
export async function retryPatientEmail(input: {
  caseId: string;
  kind: EmailKind;
}): Promise<ActionResult<{ messageId?: string }>> {
  await requireSignedIn();
  const parsed = RetryInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  return sendPatientEmail({ caseId: parsed.data.caseId, kind: parsed.data.kind, alsoMarkStep: false });
}

export async function listEmailLogs(caseId: string): Promise<EmailLog[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("email_logs")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as EmailLog[];
}
