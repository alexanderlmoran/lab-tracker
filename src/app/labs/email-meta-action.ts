"use server";

import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { loadEmailConfig } from "@/lib/email/render";
import {
  loadAllPatientTemplates,
  type PatientEmailKind,
} from "@/lib/email/template-data";
import type { LabCase } from "@/lib/types";

const Input = z.object({
  caseId: z.string().uuid(),
  kind: z.enum(["sample_sent", "partial_uploaded", "complete_uploaded", "rof_followup"]),
});

export type PriorSend = {
  status: "sent" | "skipped";
  createdAt: string;
  resendMessageId: string | null;
  totalSentCount: number;
};

export type EmailMeta = {
  to: string;
  from: string;
  replyTo: string | null;
  bcc: string[];
  subject: string;
  isTestRedirect: boolean;
  testRedirectTarget: string | null;
  priorSend: PriorSend | null;
};

/** Preview of the exact subject + BCC list + recipient that the next send
 * will use. Reads from the same merged template source as render.ts so the
 * preview drawer never drifts from what actually goes out. */
export async function getEmailMeta(input: {
  caseId: string;
  kind: PatientEmailKind;
}): Promise<{ ok: true; data: EmailMeta } | { ok: false; error: string }> {
  await requireSignedIn();
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("patient_email")
    .eq("id", parsed.data.caseId)
    .maybeSingle();
  const row = caseRow as Pick<LabCase, "patient_email"> | null;
  if (!row) return { ok: false, error: "Case not found" };

  const { data: priorRows } = await db
    .from("email_logs")
    .select("status, created_at, resend_message_id")
    .eq("case_id", parsed.data.caseId)
    .eq("kind", parsed.data.kind)
    .in("status", ["sent", "skipped"])
    .order("created_at", { ascending: false });

  const priorList = (priorRows ?? []) as Array<{
    status: "sent" | "skipped";
    created_at: string;
    resend_message_id: string | null;
  }>;
  const latest = priorList[0] ?? null;
  const sentCount = priorList.filter((r) => r.status === "sent").length;

  const [ctx, templates] = await Promise.all([
    loadEmailConfig(),
    loadAllPatientTemplates(),
  ]);
  const template = templates[parsed.data.kind];
  const subject = ctx.testRedirect
    ? `[TEST → ${row.patient_email}] ${template.subject}`
    : template.subject;

  return {
    ok: true,
    data: {
      to: ctx.testRedirect ?? row.patient_email,
      from: ctx.fromHeader,
      replyTo: ctx.replyTo ?? null,
      bcc: ctx.testRedirect ? [] : template.bcc,
      subject,
      isTestRedirect: Boolean(ctx.testRedirect),
      testRedirectTarget: ctx.testRedirect,
      priorSend: latest
        ? {
            status: latest.status,
            createdAt: latest.created_at,
            resendMessageId: latest.resend_message_id,
            totalSentCount: sentCount,
          }
        : null,
    },
  };
}
