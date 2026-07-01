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
import { getCaseStaleness, getStaleDaysThreshold, getColumnFor } from "@/lib/columns";
import { getIntegrityReport, type GapCase } from "@/lib/labs/integrity";
import { appBaseUrl } from "@/lib/app-url";
import { isLikelyLostKit, type LostKitCase } from "@/lib/labs/result-window";
import type { EmailKind, LabCase } from "@/lib/types";

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
  /** When set, the send is logged to email_logs per case (queued → sent /
   * failed) so it shows in the case's email history — same wiring as the
   * Nadia/Allison dispatch in internal.ts. Cron digests omit it (they span
   * many cases and have their own lab_events trail). */
  log?: { caseIds: string[]; kind: EmailKind };
}): Promise<DispatchResult> {
  const ctx = await loadEmailConfig();
  const isTestRedirect = Boolean(ctx.testRedirect);
  const actualTo = isTestRedirect ? ctx.testRedirect! : args.to;
  const actualSubject = isTestRedirect
    ? `[TEST → ${args.to}] ${args.subject}`
    : args.subject;

  const db = getSupabaseAdmin();
  const logIds: string[] = [];
  if (args.log) {
    for (const caseId of args.log.caseIds) {
      const { data } = await db
        .from("email_logs")
        .insert({
          case_id: caseId,
          kind: args.log.kind,
          status: "queued",
          to_address: args.to,
        })
        .select("id")
        .single();
      if (data?.id) logIds.push(data.id);
    }
  }

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
    for (const id of logIds) {
      await db
        .from("email_logs")
        .update({ status: "sent", resend_message_id: result.data?.id ?? null })
        .eq("id", id);
    }
    return { ok: true, messageId: result.data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed";
    for (const id of logIds) {
      await db
        .from("email_logs")
        .update({ status: "failed", error_message: msg })
        .eq("id", id);
    }
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
  const base = appBaseUrl();
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
    // Logged per case so the PB-completion notice shows in the case's email
    // history (Alex, 2026-06-11) — under its own kind, NOT "complete_uploaded"
    // (the patient email), so history never implies the patient was emailed.
    log: { caseIds: [c.id], kind: "complete_upload_notice" },
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
<p style="margin-top:16px;color:#71717a;font-size:11px;">Open the board to act on these → ${appBaseUrl()}/labs?stale=1</p>
</body></html>`;
  const text =
    `Daily stale-case digest\n\n${stale.length} case(s) across ${patientCount} patient(s) idle ${threshold}+ days.\n` +
    textRows.join("\n") +
    `\n\nOpen the board to act: ${appBaseUrl()}/labs?stale=1\n`;

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
// #5 — Daily Pending-Upload digest (Catherine + Nadia)
// ─────────────────────────────────────────────────────────────────────────

export type PendingDigestSummary = {
  ok: boolean;
  pendingCount: number;
  recipients: string[];
  emailMessageId?: string;
  emailError?: string;
};

/** Recipients for the pending-upload list: Nadia (the standard digest target)
 *  PLUS Catherine. Catherine's address comes from app_settings.catherine_email
 *  or the CATHERINE_EMAIL env var (set one of those so she actually receives it;
 *  otherwise only Nadia gets it). De-duped, lowercased. */
async function pendingDigestRecipients(): Promise<string[]> {
  const out = new Set<string>();
  const nadia = (await digestRecipient()).trim();
  if (nadia) out.add(nadia.toLowerCase());
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("key", "catherine_email")
      .maybeSingle();
    const cat = ((data as { value: string | null } | null)?.value ?? "").trim();
    if (cat) out.add(cat.toLowerCase());
  } catch {
    /* env-only fallback below */
  }
  const catEnv = process.env.CATHERINE_EMAIL?.trim();
  if (catEnv) out.add(catEnv.toLowerCase());
  return [...out];
}

/**
 * Daily "what's in Pending Upload" list for Catherine + Nadia — the cases whose
 * sample is delivered (or partial/complete received) and now owe a portal check
 * + post. Mirrors the Pending Upload board lane exactly (getColumnFor ===
 * 'pending_upload'), oldest-delivered first so the most-overdue checks lead.
 */
export async function runPendingDigest(): Promise<PendingDigestSummary> {
  const db = getSupabaseAdmin();
  const recipients = await pendingDigestRecipients();
  const { data, error } = await db
    .from("lab_cases")
    .select("*")
    .is("archived_at", null)
    .is("deleted_at", null);
  if (error) return { ok: false, pendingCount: 0, recipients, emailError: error.message };

  const cases = (data ?? []) as LabCase[];
  const pending = cases.filter((c) => getColumnFor(c) === "pending_upload");
  if (pending.length === 0) return { ok: true, pendingCount: 0, recipients };

  const daysSince = (iso: string | null): number | null =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;
  // Most-overdue first: longest since delivered (or since last update as a proxy).
  pending.sort((a, b) => {
    const da = daysSince(a.tracking_delivered_at) ?? daysSince(a.updated_at) ?? 0;
    const dbb = daysSince(b.tracking_delivered_at) ?? daysSince(b.updated_at) ?? 0;
    return dbb - da;
  });

  const rows: string[] = [];
  const textRows: string[] = [];
  for (const c of pending) {
    const d = daysSince(c.tracking_delivered_at);
    const when = d == null ? (c.tracking_status ?? "—") : `delivered ${d}d ago`;
    rows.push(
      `<tr><td style="padding:4px 10px 4px 0;">${escapeHtml(c.patient_name)}</td><td style="padding:4px 10px 4px 0;color:#52525b;">${escapeHtml(labLabel(c))}</td><td style="padding:4px 0;color:#71717a;font-size:12px;">${escapeHtml(when)}</td></tr>`,
    );
    textRows.push(`  • ${c.patient_name} — ${labLabel(c)} (${when})`);
  }

  const url = `${appBaseUrl()}/labs?tab=labs`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 4px;font-size:16px;">Pending Upload — daily check</h2>
<p style="margin:0 0 12px;color:#52525b;font-size:13px;">${pending.length} case${pending.length === 1 ? "" : "s"} delivered/received and waiting on a portal check + post to PracticeBetter. Oldest first.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;width:100%;max-width:600px;">${rows.join("")}</table>
<p style="margin-top:16px;color:#71717a;font-size:11px;">Open the Pending Upload lane → <a href="${url}" style="color:#4338ca;">${escapeHtml(url)}</a></p>
</body></html>`;
  const text =
    `Pending Upload — daily check\n\n${pending.length} case(s) delivered/received, waiting on a portal check + post (oldest first):\n` +
    textRows.join("\n") +
    `\n\nOpen the board: ${url}\n`;

  let emailError: string | undefined;
  let emailMessageId: string | undefined;
  for (const to of recipients) {
    const send = await dispatchInternal({ to, subject: "Pending Upload — daily check", html, text });
    if (!send.ok) emailError = send.error;
    else emailMessageId = send.messageId;
  }
  return { ok: !emailError, pendingCount: pending.length, recipients, emailMessageId, emailError };
}

// ─────────────────────────────────────────────────────────────────────────
// System-integrity audit — DOB / accession gaps, chased to zero
// ─────────────────────────────────────────────────────────────────────────

export type IntegrityAuditSummary = {
  ok: boolean;
  gapCount: number;
  dobGaps: number;
  accessionGaps: number;
  collisions: number;
  recipients: string[];
  emailMessageId?: string;
  emailError?: string;
};

/**
 * Daily zero-gap audit. Emails the list of active cases missing a DOB or a
 * shipped-case accession (and any accession collision) so nothing slips silently.
 * Sends ONLY when there's something to chase — the Analytics → Integrity tab
 * always shows the live state (green when clean).
 */
export async function runIntegrityAudit(): Promise<IntegrityAuditSummary> {
  const report = await getIntegrityReport();
  const recipients = await pendingDigestRecipients();
  const summary: IntegrityAuditSummary = {
    ok: true,
    gapCount: report.gapCount,
    dobGaps: report.dobGaps.length,
    accessionGaps: report.accessionGaps.length,
    collisions: report.collisions.length,
    recipients,
  };
  if (report.gapCount === 0 && report.collisions.length === 0) return summary;

  const url = `${appBaseUrl()}/labs/analytics?tab=integrity`;
  const listHtml = (cases: GapCase[]) =>
    cases
      .slice(0, 100)
      .map(
        (c) =>
          `<li>${escapeHtml(c.patientName)} <span style="color:#71717a;">— ${escapeHtml(c.labPanel ? `${c.labName} · ${c.labPanel}` : c.labName)}</span></li>`,
      )
      .join("");
  const listText = (cases: GapCase[]) =>
    cases.map((c) => `  • ${c.patientName} — ${c.labPanel ? `${c.labName} · ${c.labPanel}` : c.labName}`).join("\n");

  const collisionHtml = report.collisions.length
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b91c1c;">⚠ Accession collisions (wrong-patient hazard — fix now):</p><ul style="margin:0;font-size:13px;color:#b91c1c;">${report.collisions
        .map((c) => `<li><span style="font-family:monospace;">${escapeHtml(c.accession)}</span> → ${c.patients.map(escapeHtml).join(", ")}</li>`)
        .join("")}</ul>`
    : "";
  const dobHtml = report.dobGaps.length
    ? `<p style="margin:12px 0 4px;font-weight:600;">Missing DOB (${report.dobGaps.length}):</p><ul style="margin:0;font-size:13px;">${listHtml(report.dobGaps)}</ul>`
    : "";
  const accHtml = report.accessionGaps.length
    ? `<p style="margin:12px 0 4px;font-weight:600;">Missing accession — shipped (${report.accessionGaps.length}):</p><ul style="margin:0;font-size:13px;">${listHtml(report.accessionGaps)}</ul>`
    : "";

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 4px;font-size:16px;">System integrity — ${report.gapCount} gap${report.gapCount === 1 ? "" : "s"} to close</h2>
<p style="margin:0 0 8px;color:#52525b;font-size:13px;">Every active case missing a DOB or a shipped accession. Goal: zero.</p>
${collisionHtml}${dobHtml}${accHtml}
<p style="margin:16px 0 0;font-size:12px;color:#71717a;">Fix them on the Integrity board → <a href="${url}" style="color:#4338ca;">${escapeHtml(url)}</a></p>
</body></html>`;
  const text =
    `System integrity — ${report.gapCount} gap(s) to close\n` +
    (report.collisions.length ? `\n⚠ ACCESSION COLLISIONS (fix now):\n` + report.collisions.map((c) => `  • ${c.accession} → ${c.patients.join(", ")}`).join("\n") + "\n" : "") +
    (report.dobGaps.length ? `\nMissing DOB (${report.dobGaps.length}):\n${listText(report.dobGaps)}\n` : "") +
    (report.accessionGaps.length ? `\nMissing accession — shipped (${report.accessionGaps.length}):\n${listText(report.accessionGaps)}\n` : "") +
    `\nFix on the Integrity board: ${url}\n`;

  let emailError: string | undefined;
  let emailMessageId: string | undefined;
  for (const to of recipients) {
    const send = await dispatchInternal({ to, subject: `System integrity — ${report.gapCount} gap(s) to close`, html, text });
    if (!send.ok) emailError = send.error;
    else emailMessageId = send.messageId;
  }
  return { ...summary, ok: !emailError, emailMessageId, emailError };
}

// ─────────────────────────────────────────────────────────────────────────
// Email queue sweeper — unwedge email_logs rows stuck at 'queued'
// ─────────────────────────────────────────────────────────────────────────

/** A queued email older than this almost certainly never dispatched — the send
 *  is insert(queued) → resend.send() → update(sent|failed) with NO transaction
 *  and no sent_at, so a crash/timeout between insert and update strands the row
 *  at 'queued' forever. Anything healthy resolves in seconds. */
const EMAIL_STUCK_AFTER_MS = 15 * 60 * 1000;

/** Marker stamped into error_message when the sweeper flips a stale 'queued' row.
 *  Used to EXCLUDE these from the failedLast24h outage count — they're
 *  dispatch-crash artifacts, not delivery failures, so they must not self-trigger
 *  a false "Resend outage" alert. */
const SWEEPER_MARKER = "email queue sweeper";

export type EmailSweepSummary = {
  ok: boolean;
  /** Rows newly flipped 'queued' → 'failed' this run. */
  swept: number;
  /** Rows still 'queued' past the stuck threshold AFTER the sweep (should be 0). */
  stillQueued: number;
  /** GENUINE delivery failures in the last 24h (excludes the sweeper's own
   *  stale-queued conversions) — surfaced so a real Resend outage shows as a count. */
  failedLast24h: number;
  error?: string;
};

/**
 * Sweep email_logs rows wedged at status='queued' past EMAIL_STUCK_AFTER_MS.
 *
 * Safety: we do NOT auto-resend (the send isn't idempotent — Resend may well have
 * delivered the email and only the status update was lost). Flag + count is the
 * safe default: mark the row 'failed' with a reason so it stops looking pending,
 * surface it in the health digest, and let a human re-send if truly needed.
 *
 * Returns the stuck/failed COUNTS too, so runHeartbeatWatch can alert on a
 * Resend/email outage instead of it hiding in per-case email history.
 */
export async function sweepStuckEmails(): Promise<EmailSweepSummary> {
  const db = getSupabaseAdmin();
  const stuckCutoff = new Date(Date.now() - EMAIL_STUCK_AFTER_MS).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Flip stale 'queued' → 'failed'. Guard on status='queued' so we never clobber
  // a row that just transitioned to 'sent' between our read and write.
  const { data: swept, error: sweepErr } = await db
    .from("email_logs")
    .update({
      status: "failed",
      error_message: `${SWEEPER_MARKER}: stuck 'queued' > ${Math.round(EMAIL_STUCK_AFTER_MS / 60000)}m (dispatch crashed/timed out before status update; NOT auto-resent — re-send manually if needed)`,
    })
    .eq("status", "queued")
    .lt("created_at", stuckCutoff)
    .select("id");
  if (sweepErr) {
    return { ok: false, swept: 0, stillQueued: 0, failedLast24h: 0, error: sweepErr.message };
  }

  // Post-sweep counts for the digest. stillQueued should be 0 after the update;
  // a non-zero value means rows are arriving faster than they're failing — itself
  // worth surfacing.
  const { count: stillQueued } = await db
    .from("email_logs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "queued")
    .lt("created_at", stuckCutoff);
  // Count GENUINE delivery failures only — exclude the rows this sweep just flipped
  // (they carry SWEEPER_MARKER). Otherwise the sweep's own stale-queued conversions
  // would self-trigger a false "Resend outage" alert via emailTrouble.
  const { count: failedLast24h } = await db
    .from("email_logs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "failed")
    .gte("created_at", dayAgo)
    .or(`error_message.is.null,error_message.not.ilike.%${SWEEPER_MARKER}%`);

  return {
    ok: true,
    swept: (swept ?? []).length,
    stillQueued: stillQueued ?? 0,
    failedLast24h: failedLast24h ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Lost-kit watchdog — a returned/exception FedEx shipment with no result
// ─────────────────────────────────────────────────────────────────────────

export type LostKitSummary = {
  ok: boolean;
  /** Cases that look like a lost kit needing re-order (distinct from generic overdue). */
  lostCount: number;
  cases: Array<{ id: string; patient: string; lab: string; trackingStatus: string | null }>;
  error?: string;
};

/**
 * Scan active sample-sent cases for LOST KITS that need re-ordering — the
 * high-value signal (the clinic lost a FedEx kit with no alert). A case qualifies
 * when it's sample-sent with nothing received, tracking went 'returned'/'exception',
 * there's no accession on file (lab_external_ref null → the lab never logged it),
 * it's past pollStartsBy + LOST_KIT_GRACE_DAYS, AND there's no live (non-superseded)
 * lab_case_pdfs row (no result ever landed). This is DISTINCT from the stale
 * digest's generic "overdue" — it's "reorder", not "chase".
 */
export async function scanLostKits(): Promise<LostKitSummary> {
  const db = getSupabaseAdmin();
  // Narrow at the DB to the only shapes that can qualify: active, sample-sent,
  // nothing received, no accession, tracking returned/exception. The pure helper
  // (isLikelyLostKit) then applies the date math.
  const { data, error } = await db
    .from("lab_cases")
    .select(
      "id, patient_name, lab_name, lab_panel, lab_external_ref, tracking_status, " +
        "step1_sample_sent, step2_partial_received, step4_complete_received, " +
        "expected_result_at_min, expected_result_at_max, collection_date, " +
        "tracking_delivered_at, created_at",
    )
    .is("archived_at", null)
    .is("deleted_at", null)
    .eq("step1_sample_sent", true)
    .eq("step2_partial_received", false)
    .eq("step4_complete_received", false)
    .is("lab_external_ref", null)
    .in("tracking_status", ["returned", "exception"]);
  if (error) return { ok: false, lostCount: 0, cases: [], error: error.message };

  // The string-concatenated select confuses PostgREST's row-type inference (it
  // types the result as a parse-error), so cast once to the fields we read —
  // same pattern as runStaleDigest's `as LabCase[]`.
  type Row = LostKitCase & { id: string; patient_name: string; lab_name: string; lab_panel: string | null };
  const rows = (data ?? []) as unknown as Row[];
  const candidates = rows.filter((c) => isLikelyLostKit(c));
  if (candidates.length === 0) return { ok: true, lostCount: 0, cases: [] };

  // Exclude any that DO have a live result PDF (a result landed despite the
  // tracking exception — not actually lost). One batched query over the survivors.
  const ids = candidates.map((c) => c.id);
  const { data: pdfs } = await db
    .from("lab_case_pdfs")
    .select("case_id")
    .in("case_id", ids)
    .is("superseded_at", null);
  const haveLivePdf = new Set((pdfs ?? []).map((p) => p.case_id as string));

  const lost = candidates.filter((c) => !haveLivePdf.has(c.id));
  return {
    ok: true,
    lostCount: lost.length,
    cases: lost.map((c) => ({
      id: c.id,
      patient: c.patient_name ?? "—",
      lab: c.lab_panel ? `${c.lab_name} · ${c.lab_panel}` : c.lab_name,
      trackingStatus: c.tracking_status ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Reliability watchdog — alert when a worker loop goes quiet (the backbone)
// ─────────────────────────────────────────────────────────────────────────

export type HeartbeatWatchSummary = {
  ok: boolean;
  staleCount: number;
  stale: Array<{ key: string; label: string; reason: string }>;
  missing: string[];
  /** Migrations present in the repo but NOT applied to prod (the lab_scraper_status
   *  class — manual SQL-editor applies silently skip). Probed by schema sentinels. */
  drift: string[];
  /** Time-bomb credential warnings (e.g. TS_AUTHKEY 90-day expiry → PB egress dies). */
  keyWarnings: string[];
  /** Email queue health — stuck/failed counts so a Resend outage ALERTS instead of
   *  hiding in per-case email history. */
  emailQueue: { swept: number; stillQueued: number; failedLast24h: number };
  /** Lost-kit signal — returned/exception shipments with no result that need re-order. */
  lostKits: LostKitSummary["cases"];
  /** PDF-pipeline smoke: null = healthy, a string = the failure (result-PDF ingest
   *  broken in THIS deploy env, the #20 "DOMMatrix" prod-only class). */
  pdfPipeline?: string | null;
  recipient?: string;
  emailMessageId?: string;
  emailError?: string;
};

/** Schema objects the most recent / load-bearing migrations introduce. The
 *  watchdog probes each every run; a missing one means its migration was never
 *  applied to prod (manual SQL-editor applies don't register in any migrations
 *  table, so this existence probe is the only drift signal we have). ADD A ROW
 *  HERE whenever a new migration adds a load-bearing table/column. */
const SCHEMA_SENTINELS: Array<{ table: string; column?: string; migration: string }> = [
  { table: "iv_infusion_series", migration: "20260616_iv_infusion_series" },
  { table: "iv_template_refs", column: "components", migration: "20260615_iv_template_components" },
  { table: "lab_cases", column: "patient_sex", migration: "20260609_lab_cases_patient_sex" },
  { table: "lab_scraper_status", migration: "20260522_lab_scraper_status" },
  { table: "patients_seed", migration: "20260614_patients_seed_profile" },
  { table: "iv_sessions", migration: "20260609_iv_sessions" },
  { table: "iv_post_jobs", migration: "20260609_iv_post_jobs" },
  { table: "lab_cases", column: "pickup_carrier", migration: "20260608_pickup_cards" },
  // PATIENT-SAFETY LOAD-BEARING: the wrong-patient guard (result-ready quarantine +
  // Approve-modal surname check) reads report_patient_name and treats null as "no
  // name to check" — so if this hand-applied 6/24 incident-fix migration ever fell
  // out of prod, the guard would silently no-op with ZERO alert. Sentinel it.
  { table: "lab_case_pdfs", column: "report_patient_name", migration: "20260624_lab_case_pdfs_report_patient_name" },
  { table: "lab_cases", column: "with_patient_at", migration: "20260624_with_patient_stage" },
  { table: "patient_aliases", migration: "20260630_patient_aliases" },
];

/** Probe each sentinel; return human labels for any whose table/column is absent
 *  in prod. A HEAD select with limit 0 is the cheapest existence check — a
 *  missing relation/column comes back as a PostgREST error, not rows. */
async function checkSchemaDrift(db: ReturnType<typeof getSupabaseAdmin>): Promise<string[]> {
  const missing: string[] = [];
  for (const s of SCHEMA_SENTINELS) {
    const { error } = await db
      .from(s.table)
      .select(s.column ?? "*", { head: true, count: "exact" })
      .limit(0);
    if (error) {
      const msg = `${error.message ?? ""}`.toLowerCase();
      // Only flag genuine "doesn't exist" — not transient errors (timeout, RLS).
      if (msg.includes("does not exist") || msg.includes("could not find") || error.code === "42P01" || error.code === "42703") {
        missing.push(`${s.table}${s.column ? `.${s.column}` : ""} (migration ${s.migration})`);
      }
    }
  }
  return missing;
}

/** Proactive credential-expiry warnings. TS_AUTHKEY (the Tailscale auth key that
 *  brings up the PB egress) expires ~90 days out with no built-in alert — when it
 *  lapses, every PB post/read dies silently. Set TS_AUTHKEY_EXPIRES_AT (ISO date)
 *  when rotating the key; this warns 14 days ahead and after expiry. */
function checkKeyExpiry(): string[] {
  const out: string[] = [];
  const iso = process.env.TS_AUTHKEY_EXPIRES_AT;
  if (iso) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) {
      const days = Math.round((ms - Date.now()) / 86_400_000);
      if (days < 0) out.push(`TS_AUTHKEY EXPIRED ${-days}d ago — PB egress (pbdrain/reconcile/ivpost) is down until rotated + secrets reset on Fly`);
      else if (days <= 14) out.push(`TS_AUTHKEY expires in ${days}d — rotate it (tailscale authkey) + reset TS_AUTHKEY on Fly before PB egress dies`);
    }
  }
  return out;
}

/** Loops we expect alive, and how long WITHOUT A SUCCESS is too long. Keys match
 *  the heartbeats written by the worker loops + /api/worker/cases (zenoti-sync). */
const WATCHED_LOOPS: Array<{ key: string; label: string; maxAgeH: number }> = [
  { key: "zenoti-sync", label: "Zenoti sync", maxAgeH: 2 },
  { key: "scrape-loop", label: "Portal scrape loop", maxAgeH: 6 },
  { key: "tracking", label: "FedEx tracking refresh", maxAgeH: 8 },
  { key: "ivpost", label: "IV auto-post loop", maxAgeH: 3 },
  { key: "pbdrain", label: "PB upload drain (final mile to PracticeBetter)", maxAgeH: 2 },
  { key: "reconcile", label: "Reconcile / auto-post engine", maxAgeH: 6 },
  { key: "gmailsync", label: "Gmail inbox sync + KK forward", maxAgeH: 1 },
];

/**
 * Push half of the reliability backbone: reads the worker heartbeats
 * (lab_scraper_status) and emails an alert if any watched loop has gone stale (no
 * success within its window) or is failing repeatedly. So an 8-day silent outage
 * pages a human on day 1 instead of being discovered by a missing result. A
 * "missing" key (no row yet) is noted but never fires an email by itself, so a
 * fresh deploy (before a loop's first cycle) doesn't false-alarm.
 */
/** Prove the PDF text pipeline actually RUNS in this deploy env. Incident #20
 *  (pdf.js "DOMMatrix is not defined") failed ONLY on Vercel — localhost passed,
 *  so a dead prod PDF stack shipped silent for a day and every result ingested
 *  with zero text. Generate a 1-page PDF and run it through the real extract path;
 *  a throw here means result-PDF ingest is broken. Returns null when healthy. */
async function checkPdfPipeline(): Promise<string | null> {
  try {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const { extractPdfText } = await import("@/lib/inbound/extract-pdf");
    const doc = await PDFDocument.create();
    const page = doc.addPage([220, 120]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("SMOKE OK", { x: 16, y: 60, size: 24, font });
    const bytes = await doc.save();
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const text = await extractPdfText(ab);
    if (!text.toUpperCase().includes("SMOKE")) {
      return `PDF pipeline ran but text extraction returned no readable content (${text.length} chars) — pdf.js may be degraded in prod`;
    }
    return null;
  } catch (e) {
    return `PDF text extraction THREW (${e instanceof Error ? e.message : String(e)}) — result-PDF ingest is broken in this deploy env`;
  }
}

export async function runHeartbeatWatch(): Promise<HeartbeatWatchSummary> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("lab_scraper_status")
    .select("portal_key, last_success_at, consecutive_failures, last_error")
    .in("portal_key", WATCHED_LOOPS.map((w) => w.key));
  const byKey = new Map((data ?? []).map((r) => [r.portal_key as string, r]));
  const now = Date.now();
  const stale: Array<{ key: string; label: string; reason: string }> = [];
  const missing: string[] = [];
  for (const w of WATCHED_LOOPS) {
    const row = byKey.get(w.key);
    if (!row) { missing.push(w.label); continue; }
    const failures = (row.consecutive_failures as number | null) ?? 0;
    const last = row.last_success_at ? new Date(row.last_success_at as string).getTime() : 0;
    const ageH = last ? (now - last) / 3_600_000 : Infinity;
    if (failures >= 3) {
      stale.push({ key: w.key, label: w.label, reason: `${failures} consecutive failures${row.last_error ? ` — ${String(row.last_error).slice(0, 120)}` : ""}` });
    } else if (ageH > w.maxAgeH) {
      stale.push({ key: w.key, label: w.label, reason: last ? `no success in ${Math.round(ageH)}h (expected ≤ ${w.maxAgeH}h)` : "no successful run on record" });
    }
  }
  // More silent-failure classes the premortem/audit flagged (same watchdog, one
  // email): migrations never applied to prod, credential time-bombs, a wedged
  // email queue (Resend outage hiding in per-case history), and lost FedEx kits.
  const drift = await checkSchemaDrift(db);
  const keyWarnings = checkKeyExpiry();
  // sweepStuckEmails also unwedges 'queued' rows as a side effect — running it
  // here folds the email-queue sweep into the watchdog's regular cadence.
  const emailSweep = await sweepStuckEmails();
  const emailQueue = {
    swept: emailSweep.swept,
    stillQueued: emailSweep.stillQueued,
    failedLast24h: emailSweep.failedLast24h,
  };
  // Email queue is "in trouble" if it's still backing up after the sweep or has
  // been failing repeatedly in the last day (an outage, not a one-off bounce).
  const emailTrouble = emailQueue.stillQueued > 0 || emailQueue.failedLast24h >= 3;
  const lostKitScan = await scanLostKits();
  const lostKits = lostKitScan.cases;
  const pdfPipeline = await checkPdfPipeline();

  if (
    stale.length === 0 &&
    drift.length === 0 &&
    keyWarnings.length === 0 &&
    !emailTrouble &&
    lostKits.length === 0 &&
    !pdfPipeline
  ) {
    return { ok: true, staleCount: 0, stale: [], missing, drift, keyWarnings, emailQueue, lostKits, pdfPipeline: null };
  }

  const recipient = await digestRecipient();
  const url = `${appBaseUrl()}/labs/analytics`;
  const problemCount =
    stale.length + drift.length + keyWarnings.length + (emailTrouble ? 1 : 0) + lostKits.length + (pdfPipeline ? 1 : 0);
  const rowsHtml = stale
    .map((s) => `<tr><td style="padding:4px 12px 4px 0;font-weight:600;">${escapeHtml(s.label)}</td><td style="padding:4px 0;color:#b91c1c;">${escapeHtml(s.reason)}</td></tr>`)
    .join("");
  const staleHtml = stale.length
    ? `<p style="margin:10px 0 4px;font-weight:600;">Worker loops quiet/failing:</p><table style="font-size:13px;border-collapse:collapse;">${rowsHtml}</table>`
    : "";
  const driftHtml = drift.length
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b91c1c;">⚠ Migration drift — schema NOT applied to prod (apply the migration in the Supabase SQL editor):</p><ul style="margin:0;font-size:13px;color:#b91c1c;">${drift.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
    : "";
  const keyHtml = keyWarnings.length
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b45309;">⏰ Credential expiry:</p><ul style="margin:0;font-size:13px;color:#b45309;">${keyWarnings.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul>`
    : "";
  const emailHtml = emailTrouble
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b91c1c;">✉ Email delivery trouble (possible Resend outage — NOT auto-resent):</p><ul style="margin:0;font-size:13px;color:#b91c1c;">${
        emailQueue.stillQueued > 0
          ? `<li>${emailQueue.stillQueued} email(s) still stuck 'queued' after sweep</li>`
          : ""
      }${
        emailQueue.failedLast24h >= 3
          ? `<li>${emailQueue.failedLast24h} email(s) failed in the last 24h</li>`
          : ""
      }${emailQueue.swept > 0 ? `<li>${emailQueue.swept} stale 'queued' row(s) swept to 'failed' this run</li>` : ""}</ul>`
    : "";
  const lostKitHtml = lostKits.length
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b91c1c;">📦 Kit lost — REORDER (returned/exception shipment, no result on file):</p><table style="font-size:13px;border-collapse:collapse;">${lostKits
        .map(
          (k) =>
            `<tr><td style="padding:4px 12px 4px 0;font-weight:600;">${escapeHtml(k.patient)}</td><td style="padding:4px 12px 4px 0;">${escapeHtml(k.lab)}</td><td style="padding:4px 0;color:#b91c1c;">${escapeHtml(k.trackingStatus ?? "—")}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const pdfHtml = pdfPipeline
    ? `<p style="margin:12px 0 4px;font-weight:600;color:#b91c1c;">📄 PDF pipeline BROKEN (result ingest dead in prod — the DOMMatrix class):</p><ul style="margin:0;font-size:13px;color:#b91c1c;"><li>${escapeHtml(pdfPipeline)}</li></ul>`
    : "";
  const missingNote = missing.length
    ? `<p style="margin:8px 0 0;color:#a16207;font-size:12px;">No heartbeat yet (normal right after a deploy): ${missing.map(escapeHtml).join(", ")}.</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#18181b;">
<h2 style="margin:0 0 6px;font-size:16px;color:#b91c1c;">⚠ Automation health alert</h2>
<p style="margin:0 0 10px;color:#52525b;font-size:13px;">${problemCount} issue(s) found — results may not be syncing/posting until resolved.</p>
${staleHtml}${driftHtml}${keyHtml}${emailHtml}${lostKitHtml}${pdfHtml}${missingNote}
<p style="margin:14px 0 0;font-size:12px;color:#71717a;">Loop down? Most common cause: a deploy left the Fly machine stopped — <code>fly machine start &lt;id&gt;</code> (or <code>bash worker/scripts/start-all-machines.sh</code>). Health view → <a href="${url}" style="color:#4338ca;">${escapeHtml(url)}</a></p>
</body></html>`;
  const text =
    `Automation health alert — ${problemCount} issue(s)\n` +
    (stale.length ? `\nWorker loops quiet/failing:\n` + stale.map((s) => `- ${s.label}: ${s.reason}`).join("\n") + "\n" : "") +
    (drift.length ? `\nMigration drift (NOT applied to prod):\n` + drift.map((d) => `- ${d}`).join("\n") + "\n" : "") +
    (keyWarnings.length ? `\nCredential expiry:\n` + keyWarnings.map((k) => `- ${k}`).join("\n") + "\n" : "") +
    (emailTrouble
      ? `\nEmail delivery trouble (NOT auto-resent):\n` +
        (emailQueue.stillQueued > 0 ? `- ${emailQueue.stillQueued} still stuck 'queued' after sweep\n` : "") +
        (emailQueue.failedLast24h >= 3 ? `- ${emailQueue.failedLast24h} failed in last 24h\n` : "") +
        (emailQueue.swept > 0 ? `- ${emailQueue.swept} stale 'queued' swept to 'failed' this run\n` : "")
      : "") +
    (lostKits.length
      ? `\nKit lost — REORDER (returned/exception, no result on file):\n` +
        lostKits.map((k) => `- ${k.patient} — ${k.lab} (${k.trackingStatus ?? "—"})`).join("\n") +
        "\n"
      : "") +
    (pdfPipeline ? `\nPDF pipeline BROKEN (result ingest dead in prod):\n- ${pdfPipeline}\n` : "") +
    (missing.length ? `\nNo heartbeat yet: ${missing.join(", ")}\n` : "") +
    `\nLoop down? Often a deploy left the Fly machine stopped — fly machine start <id>.\nHealth: ${url}\n`;

  const send = await dispatchInternal({ to: recipient, subject: "⚠ Lab automation health alert", html, text });
  return {
    ok: send.ok,
    staleCount: stale.length,
    stale,
    missing,
    drift,
    keyWarnings,
    emailQueue,
    lostKits,
    pdfPipeline,
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
