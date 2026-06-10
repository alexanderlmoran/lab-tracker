// Background-job emails: daily stale-case digest + RoF-scheduling reminder.
// Both are fired from Vercel crons under /api/cron/*, not from user actions,
// so auth is the cron route's responsibility (CRON_SECRET).
//
// Layout choice: simple HTML strings instead of React Email templates. These
// are internal-staff emails, not patient-facing — we don't need brand polish,
// just legibility. Keeps the module self-contained and avoids one more place
// where template props can drift.

import "server-only";
import { Resend } from "resend";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { loadEmailConfig, INTERNAL_SUBJECT } from "./render";
import { getCaseStaleness, getStaleDaysThreshold } from "@/lib/columns";
import type { LabCase } from "@/lib/types";

type DispatchResult = { ok: true; messageId?: string } | { ok: false; error: string };

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

/**
 * Single configurable digest recipient. Resolution order:
 *   1. app_settings.digest_email (admin-editable in /labs/settings)
 *   2. DIGEST_EMAIL env var
 *   3. NADIA_EMAIL env var
 *   4. Hardcoded fallback
 *
 * The DB read is async; the env-only fallback is sync. Keep both available
 * so callers that can't await (rare) still get a working value.
 */
async function digestRecipient(): Promise<string> {
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("key", "digest_email")
      .maybeSingle();
    const fromDb = ((data as { value: string | null } | null)?.value ?? "").trim();
    if (fromDb) return fromDb;
  } catch {
    // Fall through to env-only resolution.
  }
  return (
    process.env.DIGEST_EMAIL?.trim() ||
    process.env.NADIA_EMAIL?.trim() ||
    "nadia@centnerwellness.com"
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function labLabel(c: LabCase): string {
  return c.lab_panel ? `${c.lab_name} · ${c.lab_panel}` : c.lab_name;
}

async function dispatchInternal(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<DispatchResult> {
  const ctx = await loadEmailConfig();
  const isTestRedirect = Boolean(ctx.testRedirect);
  const actualTo = isTestRedirect ? ctx.testRedirect! : args.to;
  const actualSubject = isTestRedirect
    ? `[TEST → ${args.to}] ${args.subject}`
    : args.subject;
  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: ctx.fromHeader,
      to: [actualTo],
      replyTo: ctx.replyTo,
      subject: actualSubject,
      html: args.html,
      text: args.text,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true, messageId: result.data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed";
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// #21 — Complete-upload notification
// ─────────────────────────────────────────────────────────────────────────

/**
 * One-off internal notification fired the moment a case's complete result
 * lands on PracticeBetter (step 5). Unlike the cron digests this is an
 * event-driven notice — `notifyCompleteUpload` in `@/lib/workflow` is the
 * single gate that calls this from every step-5 flip path (worker upload,
 * manual email, "already on PB"). Reuses the same internal dispatch as the
 * digests so routing/test-redirect behaves identically.
 */
export async function sendCompleteUploadNotice(args: {
  patientCase: LabCase;
  /** PB labrequest id when the upload went through the worker, for the receipt. */
  pbLabRequestId?: string | null;
}): Promise<DispatchResult> {
  const c = args.patientCase;
  const recipient = await digestRecipient();
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://labs";
  const caseUrl = `${base}/labs/${c.id}`;
  const ref = args.pbLabRequestId
    ? `<p style="margin:0 0 8px;color:#71717a;font-size:12px;">PB labrequest ${escapeHtml(args.pbLabRequestId)}</p>`
    : "";

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 4px;font-size:16px;">Complete result uploaded</h2>
<p style="margin:0 0 6px;color:#52525b;font-size:13px;">${escapeHtml(c.patient_name)}'s ${escapeHtml(labLabel(c))} result is now on PracticeBetter.</p>
${ref}<p style="margin:12px 0 0;font-size:13px;"><a href="${caseUrl}" style="color:#4338ca;">Open the case →</a></p>
</body></html>`;
  const text =
    `Complete result uploaded\n\n` +
    `${c.patient_name} — ${labLabel(c)} is now on PracticeBetter.\n` +
    (args.pbLabRequestId ? `PB labrequest ${args.pbLabRequestId}\n` : "") +
    `\nOpen the case: ${caseUrl}\n`;

  return dispatchInternal({
    to: recipient,
    subject: INTERNAL_SUBJECT.complete_upload,
    html,
    text,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// #5 — Daily stale-case digest
// ─────────────────────────────────────────────────────────────────────────

export type StaleDigestSummary = {
  ok: boolean;
  staleCount: number;
  patientCount: number;
  recipient: string;
  emailMessageId?: string;
  emailError?: string;
};

/**
 * Find every active case that's gone idle past the stale threshold and
 * email a single grouped digest. Idempotent within a day in practice — the
 * cron only fires once.
 */
export async function runStaleDigest(opts: {
  /** Override threshold for testing. */
  thresholdDays?: number;
}): Promise<StaleDigestSummary> {
  const threshold = opts.thresholdDays ?? getStaleDaysThreshold();
  const recipient = await digestRecipient();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("*")
    .is("archived_at", null)
    .is("deleted_at", null);
  if (error) {
    return {
      ok: false,
      staleCount: 0,
      patientCount: 0,
      recipient,
      emailError: error.message,
    };
  }
  const cases = (data ?? []) as LabCase[];
  const stale = cases.filter((c) => {
    const s = getCaseStaleness(c, threshold);
    return s.stale;
  });

  // Group by patient_email so the digest reads as a punch list of patients,
  // not a disjoint list of labs.
  const byPatient = new Map<string, { name: string; cases: LabCase[] }>();
  for (const c of stale) {
    const key = c.patient_email.toLowerCase();
    const g = byPatient.get(key) ?? { name: c.patient_name, cases: [] };
    g.cases.push(c);
    byPatient.set(key, g);
  }
  const patientCount = byPatient.size;

  if (stale.length === 0) {
    return {
      ok: true,
      staleCount: 0,
      patientCount: 0,
      recipient,
    };
  }

  const rows: string[] = [];
  const textRows: string[] = [];
  for (const [email, group] of byPatient.entries()) {
    rows.push(
      `<tr><td colspan="3" style="padding-top:14px;font-weight:600;">${escapeHtml(group.name)} <span style="color:#71717a;font-weight:400;font-size:12px;">${escapeHtml(email)}</span></td></tr>`,
    );
    textRows.push(`\n${group.name} (${email})`);
    for (const c of group.cases) {
      const s = getCaseStaleness(c, threshold);
      rows.push(
        `<tr><td style="padding:4px 8px 4px 16px;">${escapeHtml(labLabel(c))}</td><td style="padding:4px 8px;color:#52525b;">${s.daysSinceProgress}d idle</td><td style="padding:4px 8px;color:#71717a;font-size:12px;">${escapeHtml(c.tracking_status ?? "—")}</td></tr>`,
      );
      textRows.push(
        `  • ${labLabel(c)} — ${s.daysSinceProgress}d idle (${c.tracking_status ?? "no tracking"})`,
      );
    }
  }

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 4px;font-size:16px;">Daily stale-case digest</h2>
<p style="margin:0 0 14px;color:#52525b;font-size:13px;">${stale.length} case${stale.length === 1 ? "" : "s"} across ${patientCount} patient${patientCount === 1 ? "" : "s"} haven't progressed in ${threshold}+ day${threshold === 1 ? "" : "s"}.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;width:100%;max-width:560px;">${rows.join("")}</table>
<p style="margin-top:16px;color:#71717a;font-size:11px;">Open the board to act on these → ${process.env.NEXT_PUBLIC_APP_URL ?? "https://labs"}/labs?stale=1</p>
</body></html>`;
  const text =
    `Daily stale-case digest\n\n${stale.length} case(s) across ${patientCount} patient(s) idle ${threshold}+ days.\n` +
    textRows.join("\n") +
    `\n\nOpen the board to act: ${process.env.NEXT_PUBLIC_APP_URL ?? "https://labs"}/labs?stale=1\n`;

  const send = await dispatchInternal({
    to: recipient,
    subject: INTERNAL_SUBJECT.stale_digest,
    html,
    text,
  });

  return {
    ok: send.ok,
    staleCount: stale.length,
    patientCount,
    recipient,
    emailMessageId: send.ok ? send.messageId : undefined,
    emailError: send.ok ? undefined : send.error,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #9 — RoF scheduling reminder
// ─────────────────────────────────────────────────────────────────────────

export type RofReminderSummary = {
  ok: boolean;
  candidateCount: number;
  remindedCount: number;
  recipient: string;
  emailMessageId?: string;
  emailError?: string;
};

const ROF_REMINDER_COOLDOWN_DAYS = 5;

/**
 * Reminder for cases stuck between "results uploaded" (step 5) and "ROF
 * booked" (step 6). Fires once per case every cooldown window so a single
 * stuck case doesn't spam the recipient daily.
 *
 * Eligibility:
 *   - active case (not archived, not deleted)
 *   - step5_complete_uploaded = true AND step6_rof_scheduled = false
 *   - updated_at > 48hr ago (rough proxy for "step 5 was a while back")
 *   - no `rof_reminder` lab_event in the last ROF_REMINDER_COOLDOWN_DAYS
 *
 * Sends ONE email listing every candidate. If the list is empty, no email
 * fires.
 */
export async function runRofReminders(): Promise<RofReminderSummary> {
  const db = getSupabaseAdmin();
  const recipient = await digestRecipient();
  const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("lab_cases")
    .select("*")
    .is("archived_at", null)
    .is("deleted_at", null)
    .eq("step5_complete_uploaded", true)
    .eq("step6_rof_scheduled", false)
    .lt("updated_at", cutoffIso);
  if (error) {
    return {
      ok: false,
      candidateCount: 0,
      remindedCount: 0,
      recipient,
      emailError: error.message,
    };
  }
  const candidates = (data ?? []) as LabCase[];
  if (candidates.length === 0) {
    return { ok: true, candidateCount: 0, remindedCount: 0, recipient };
  }

  // Filter out cases reminded in the last cooldown window. We tag the
  // event with kind=case_edited + meta.rof_reminder=true so a separate
  // lab_event kind isn't required.
  const cooldownCutoff = new Date(
    Date.now() - ROF_REMINDER_COOLDOWN_DAYS * 86_400_000,
  ).toISOString();
  const { data: recentEvents } = await db
    .from("lab_events")
    .select("case_id, meta, created_at")
    .in(
      "case_id",
      candidates.map((c) => c.id),
    )
    .gte("created_at", cooldownCutoff);
  const recentlyReminded = new Set<string>();
  for (const ev of (recentEvents ?? []) as Array<{
    case_id: string;
    meta: { rof_reminder?: boolean } | null;
  }>) {
    if (ev.meta?.rof_reminder) recentlyReminded.add(ev.case_id);
  }
  const eligible = candidates.filter((c) => !recentlyReminded.has(c.id));
  if (eligible.length === 0) {
    return {
      ok: true,
      candidateCount: candidates.length,
      remindedCount: 0,
      recipient,
    };
  }

  // Group by patient for readability.
  const byPatient = new Map<string, { name: string; email: string; cases: LabCase[] }>();
  for (const c of eligible) {
    const key = c.patient_email.toLowerCase();
    const g = byPatient.get(key) ?? {
      name: c.patient_name,
      email: c.patient_email,
      cases: [],
    };
    g.cases.push(c);
    byPatient.set(key, g);
  }

  const rows: string[] = [];
  const textRows: string[] = [];
  for (const [, g] of byPatient.entries()) {
    rows.push(
      `<tr><td colspan="2" style="padding-top:12px;font-weight:600;">${escapeHtml(g.name)} <span style="color:#71717a;font-weight:400;font-size:12px;">${escapeHtml(g.email)}</span></td></tr>`,
    );
    textRows.push(`\n${g.name} (${g.email})`);
    for (const c of g.cases) {
      rows.push(
        `<tr><td style="padding:4px 8px 4px 16px;">${escapeHtml(labLabel(c))}</td><td style="padding:4px 8px;color:#71717a;font-size:12px;">Last activity ${c.updated_at.slice(0, 10)}</td></tr>`,
      );
      textRows.push(
        `  • ${labLabel(c)} — last activity ${c.updated_at.slice(0, 10)}`,
      );
    }
  }

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 4px;font-size:16px;">ROF scheduling reminder</h2>
<p style="margin:0 0 14px;color:#52525b;font-size:13px;">${eligible.length} patient${eligible.length === 1 ? "" : "s"} (${byPatient.size} group${byPatient.size === 1 ? "" : "s"}) have results uploaded but no ROF on the books yet. Book in Zenoti or update the case.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;width:100%;max-width:560px;">${rows.join("")}</table>
<p style="margin-top:16px;color:#71717a;font-size:11px;">Next nudge in ${ROF_REMINDER_COOLDOWN_DAYS} days unless step 6 ticks.</p>
</body></html>`;
  const text =
    `ROF scheduling reminder\n\n${eligible.length} patient(s) (${byPatient.size} group(s)) with results uploaded but no ROF booked.\n` +
    textRows.join("\n") +
    `\n\nNext nudge in ${ROF_REMINDER_COOLDOWN_DAYS} days unless step 6 ticks.\n`;

  const send = await dispatchInternal({
    to: recipient,
    subject: INTERNAL_SUBJECT.rof_reminder,
    html,
    text,
  });

  // Log a per-case event so the cooldown filter catches the next run. We
  // do this even on send failure so a flaky Resend doesn't trigger
  // duplicate sends on the next cron tick — the timeline still shows
  // intent, and the operator can re-send manually.
  await db.from("lab_events").insert(
    eligible.map((c) => ({
      case_id: c.id,
      kind: "case_edited" as const,
      actor: "cron",
      meta: {
        rof_reminder: true,
        ok: send.ok,
        ...(send.ok ? {} : { error: send.error }),
      },
      note: send.ok
        ? "RoF scheduling reminder emailed"
        : `RoF reminder send failed: ${send.error}`,
    })),
  );

  return {
    ok: send.ok,
    candidateCount: candidates.length,
    remindedCount: eligible.length,
    recipient,
    emailMessageId: send.ok ? send.messageId : undefined,
    emailError: send.ok ? undefined : send.error,
  };
}
