"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { getResend } from "@/lib/resend";
import { envEmailConfig } from "@/lib/email/render";
import { generateReqForm } from "../req-form-actions";
import { resolveReqForm } from "@/lib/req-forms/resolve";
import type { PhlebStatus, PhlebVendor } from "@/lib/phlebotomy";
import { formatPrice, vendorLabel } from "@/lib/phlebotomy";

export type PhlebActionResult =
  | { ok: true }
  | { ok: false; error: string };

/** One row of the Phlebotomy worklist = one mobile-draw "sitting" (a patient +
 *  collection_date), anchored on the clinic's "Mobile Phlebotomy" service case
 *  and joined to its most recent appointment. `appt_id` is null when no
 *  appointment exists yet — the draw sits in "Needs Scheduling". `labs` lists
 *  every lab being drawn that sitting. */
export type PhlebApptRow = {
  // ── Appointment (latest per anchor case; null when none yet) ──
  appt_id: string | null;
  vendor: string | null;
  vendor_other: string | null;
  phlebotomist_name: string | null;
  status: PhlebStatus;
  patient_window: string | null;
  appt_at: string | null;
  price_cents: number | null;
  req_forwarded_at: string | null;
  patient_confirmed_at: string | null;
  vendor_confirmed_at: string | null;
  drawn_at: string | null;
  completed_confirmed_at: string | null;
  canceled_at: string | null;
  notes: string | null;
  // ── Draw context ──
  case_id: string; // anchor case (the "Mobile Phlebotomy" service case, preferred)
  patient_name: string;
  patient_email: string;
  patient_phone: string | null;
  collection_date: string | null;
  labs: string[]; // every lab being drawn this sitting
  tracking_status: string | null;
  tracking_delivered_at: string | null;
};

const APPT_COLS =
  "id, case_id, vendor, vendor_other, phlebotomist_name, status, patient_window, appt_at, price_cents, req_forwarded_at, patient_confirmed_at, vendor_confirmed_at, drawn_at, completed_confirmed_at, canceled_at, notes, created_at";

type ApptRecord = {
  id: string;
  case_id: string;
  vendor: string | null;
  vendor_other: string | null;
  phlebotomist_name: string | null;
  status: PhlebStatus;
  patient_window: string | null;
  appt_at: string | null;
  price_cents: number | null;
  req_forwarded_at: string | null;
  patient_confirmed_at: string | null;
  vendor_confirmed_at: string | null;
  drawn_at: string | null;
  completed_confirmed_at: string | null;
  canceled_at: string | null;
  notes: string | null;
  created_at: string;
};

// ── Logging ────────────────────────────────────────────────────────────────
type Db = ReturnType<typeof getSupabaseAdmin>;

async function logPhleb(
  db: Db,
  caseId: string,
  actor: string,
  note: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  // Activity logging is secondary — never let it sink the action it's recording.
  // In particular, if the standalone `phlebotomy_event` enum migration hasn't
  // been applied yet, this insert returns an enum error; we surface it to the
  // server log but the lifecycle update already committed.
  const { error } = await db.from("lab_events").insert({
    case_id: caseId,
    kind: "phlebotomy_event",
    actor,
    note,
    meta: meta ?? null,
  });
  if (error) console.warn(`[phlebotomy] activity log skipped: ${error.message}`);
}

/** Latest non-canceled appointment for a case, creating a fresh one if none
 *  exists (or the only one is canceled — a re-book starts clean). Returns its id. */
async function getOrCreateOpenAppt(
  db: Db,
  caseId: string,
  actor: string,
): Promise<string> {
  const { data } = await db
    .from("phlebotomy_appointments")
    .select("id")
    .eq("case_id", caseId)
    .neq("status", "canceled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.id) return data.id as string;
  const { data: created, error } = await db
    .from("phlebotomy_appointments")
    .insert({ case_id: caseId, updated_by: actor })
    .select("id")
    .single();
  if (error || !created) {
    throw new Error(error?.message ?? "Could not create appointment");
  }
  return created.id as string;
}

// ── Board ────────────────────────────────────────────────────────────────
type AnchorRow = {
  id: string;
  patient_name: string;
  patient_email: string;
  patient_phone: string | null;
  lab_name: string;
  collection_date: string | null;
  tracking_status: string | null;
  tracking_delivered_at: string | null;
};

/** The clinic marks each mobile draw with a dedicated lab_name = "Mobile
 *  Phlebotomy" service case; that (not the individual labs) is the draw. */
const SERVICE_LAB = /mobile phlebotomy/i;
const ANCHOR_SEL =
  "id, patient_name, patient_email, patient_phone, lab_name, collection_date, tracking_status, tracking_delivered_at";

/** Identity of a draw = one patient sitting on one date. */
function drawKey(email: string, date: string | null): string {
  return `${email.trim().toLowerCase()}|${date ?? ""}`;
}

/**
 * The Phlebotomy worklist: one card per mobile-draw sitting. A draw is a patient
 * + collection_date that has either a "Mobile Phlebotomy" service case (the
 * clinic's convention) or a case manually flagged collection_method=
 * 'mobile_phlebotomy'. One sitting covers many labs, so the appointment +
 * activity anchor to the service case (preferred) — one draw = one appointment,
 * not one per lab — and the card lists every lab being drawn.
 */
export async function listPhlebotomyBoard(): Promise<PhlebApptRow[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  // Anchors via two simple queries unioned by id (robust vs a spaced-ilike .or()).
  const [byName, byFlag] = await Promise.all([
    db.from("lab_cases").select(ANCHOR_SEL).ilike("lab_name", "%mobile phlebotomy%").is("deleted_at", null).is("archived_at", null),
    db.from("lab_cases").select(ANCHOR_SEL).eq("collection_method", "mobile_phlebotomy").is("deleted_at", null).is("archived_at", null),
  ]);
  if (byName.error) throw new Error(byName.error.message);
  if (byFlag.error) throw new Error(byFlag.error.message);

  const seen = new Set<string>();
  const anchorsAll: AnchorRow[] = [];
  for (const r of [...(byName.data ?? []), ...(byFlag.data ?? [])] as AnchorRow[]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    anchorsAll.push(r);
  }
  if (anchorsAll.length === 0) return [];

  // One anchor per draw; prefer the service case (it carries no real lab).
  const anchorByDraw = new Map<string, AnchorRow>();
  for (const a of anchorsAll) {
    const k = drawKey(a.patient_email, a.collection_date);
    const cur = anchorByDraw.get(k);
    if (!cur || (SERVICE_LAB.test(a.lab_name) && !SERVICE_LAB.test(cur.lab_name))) {
      anchorByDraw.set(k, a);
    }
  }

  // Sibling labs per draw: the patient's other cases on the same date (minus the
  // service anchor). One batched query over the involved patients.
  const emails = [...new Set(anchorsAll.map((a) => a.patient_email))];
  const { data: sibRows } = await db
    .from("lab_cases")
    .select("patient_email, collection_date, lab_name")
    .in("patient_email", emails)
    .is("deleted_at", null);
  const labsByDraw = new Map<string, string[]>();
  for (const s of (sibRows ?? []) as Array<{ patient_email: string; collection_date: string | null; lab_name: string }>) {
    if (SERVICE_LAB.test(s.lab_name)) continue;
    const k = drawKey(s.patient_email, s.collection_date);
    if (!anchorByDraw.has(k)) continue;
    const arr = labsByDraw.get(k) ?? [];
    arr.push(s.lab_name);
    labsByDraw.set(k, arr);
  }

  // Latest appointment per anchor case.
  const anchorIds = [...anchorByDraw.values()].map((a) => a.id);
  const { data: apptRows } = await db
    .from("phlebotomy_appointments")
    .select(APPT_COLS)
    .in("case_id", anchorIds)
    .order("created_at", { ascending: false });
  const latest = new Map<string, ApptRecord>();
  for (const a of (apptRows ?? []) as ApptRecord[]) {
    if (!latest.has(a.case_id)) latest.set(a.case_id, a);
  }

  return [...anchorByDraw.entries()].map(([k, c]) => {
    const a = latest.get(c.id);
    const labs = (labsByDraw.get(k) ?? []).sort((x, y) => x.localeCompare(y));
    return {
      appt_id: a?.id ?? null,
      vendor: a?.vendor ?? null,
      vendor_other: a?.vendor_other ?? null,
      phlebotomist_name: a?.phlebotomist_name ?? null,
      status: (a?.status ?? "needs_scheduling") as PhlebStatus,
      patient_window: a?.patient_window ?? null,
      appt_at: a?.appt_at ?? null,
      price_cents: a?.price_cents ?? null,
      req_forwarded_at: a?.req_forwarded_at ?? null,
      patient_confirmed_at: a?.patient_confirmed_at ?? null,
      vendor_confirmed_at: a?.vendor_confirmed_at ?? null,
      drawn_at: a?.drawn_at ?? null,
      completed_confirmed_at: a?.completed_confirmed_at ?? null,
      canceled_at: a?.canceled_at ?? null,
      notes: a?.notes ?? null,
      case_id: c.id,
      patient_name: c.patient_name,
      patient_email: c.patient_email,
      patient_phone: c.patient_phone,
      collection_date: c.collection_date,
      labs,
      tracking_status: c.tracking_status,
      tracking_delivered_at: c.tracking_delivered_at,
    };
  });
}

/** Active, pre-sample-sent cases not already flagged mobile — the candidates the
 *  "Add to phlebotomy" picker offers. Most-recent collection date first. */
export async function listAddablePhlebotomyCases(): Promise<
  Array<{ id: string; patient_name: string; lab_name: string; collection_date: string | null }>
> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("id, patient_name, lab_name, collection_date")
    .is("deleted_at", null)
    .is("archived_at", null)
    .eq("step1_sample_sent", false)
    .not("lab_name", "ilike", "%mobile phlebotomy%") // service cases auto-surface
    .or("collection_method.is.null,collection_method.neq.mobile_phlebotomy")
    .order("collection_date", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    patient_name: string;
    lab_name: string;
    collection_date: string | null;
  }>;
}

// ── Membership ─────────────────────────────────────────────────────────────
export async function addCaseToPhlebotomy(caseId: string): Promise<PhlebActionResult> {
  const user = await requireSignedIn();
  const actor = user.email ?? "staff";
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ collection_method: "mobile_phlebotomy" })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message };
  await getOrCreateOpenAppt(db, caseId, actor);
  await logPhleb(db, caseId, actor, "Added to mobile phlebotomy — needs scheduling");
  revalidatePath("/labs");
  return { ok: true };
}

export async function removeCaseFromPhlebotomy(caseId: string): Promise<PhlebActionResult> {
  const user = await requireSignedIn();
  const actor = user.email ?? "staff";
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("lab_cases")
    .update({ collection_method: "self" })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message };
  // Cancel any open appointment so it doesn't linger if re-added later.
  await db
    .from("phlebotomy_appointments")
    .update({ status: "canceled", canceled_at: new Date().toISOString(), updated_by: actor })
    .eq("case_id", caseId)
    .neq("status", "canceled");
  await logPhleb(db, caseId, actor, "Removed from mobile phlebotomy (patient self-draw)");
  revalidatePath("/labs");
  return { ok: true };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
/** Ensure an open appointment exists, apply a partial update, and log. */
async function patchAppt(
  caseId: string,
  patch: Record<string, unknown>,
  note: string,
  meta?: Record<string, unknown>,
): Promise<PhlebActionResult> {
  const user = await requireSignedIn();
  const actor = user.email ?? "staff";
  const db = getSupabaseAdmin();
  let apptId: string;
  try {
    apptId = await getOrCreateOpenAppt(db, caseId, actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No appointment" };
  }
  const { error } = await db
    .from("phlebotomy_appointments")
    .update({ ...patch, updated_by: actor })
    .eq("id", apptId);
  if (error) return { ok: false, error: error.message };
  await logPhleb(db, caseId, actor, note, meta);
  revalidatePath("/labs");
  return { ok: true };
}

/** Patient gave a date range (patient-first). Doesn't change status. */
export async function setPatientWindow(caseId: string, window: string): Promise<PhlebActionResult> {
  const w = window.trim();
  return patchAppt(caseId, { patient_window: w || null }, w ? `Patient window: ${w}` : "Patient window cleared");
}

/** Pick a vendor and request the draw → status 'requested'. */
export async function requestVendor(
  caseId: string,
  vendor: PhlebVendor,
  vendorOther?: string,
): Promise<PhlebActionResult> {
  const other = (vendorOther ?? "").trim();
  if (vendor === "other" && !other) {
    return { ok: false, error: "Enter the vendor name for 'Other'." };
  }
  const label = vendorLabel(vendor, other);
  return patchAppt(
    caseId,
    { vendor, vendor_other: vendor === "other" ? other : null, status: "requested" },
    `Requested draw from ${label}`,
    { vendor, vendorOther: other || null },
  );
}

/**
 * Interpret a naive "YYYY-MM-DDTHH:mm" (no offset — what <input type="datetime-
 * local"> emits) as America/New_York wall time and return the matching UTC ISO
 * instant, accounting for EDT/EST. A bare `new Date(local)` would parse it as
 * UTC on the Vercel server, shifting every clinic appointment 4–5h earlier.
 * Strings that already carry a timezone (Z or ±hh:mm) are passed through.
 */
function easternLocalToUtcIso(local: string): string {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(local)) return new Date(local).toISOString();
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return new Date(local).toISOString();
  const [, y, mo, d, h, mi] = m.map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(wallAsUtc))) p[part.type] = part.value;
  const nyAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMs = nyAsUtc - wallAsUtc; // how far NY is from UTC at this instant
  return new Date(wallAsUtc - offsetMs).toISOString();
}

/** Confirm appointment time + phlebotomist cost → status 'scheduled'. */
export async function scheduleAppointment(
  caseId: string,
  input: { apptAtIso: string; priceCents?: number | null; phlebotomistName?: string | null },
): Promise<PhlebActionResult> {
  if (!input.apptAtIso) return { ok: false, error: "Pick an appointment date/time." };
  const utcIso = easternLocalToUtcIso(input.apptAtIso);
  if (Number.isNaN(Date.parse(utcIso))) return { ok: false, error: "Invalid date/time." };
  return patchAppt(
    caseId,
    {
      appt_at: utcIso,
      price_cents: input.priceCents ?? null,
      phlebotomist_name: (input.phlebotomistName ?? "").trim() || null,
      status: "scheduled",
    },
    `Scheduled for ${new Date(utcIso).toLocaleString("en-US", { timeZone: "America/New_York" })}`,
    { priceCents: input.priceCents ?? null },
  );
}

/** Update just the phlebotomist cost (cost-history edit). */
export async function setApptPrice(caseId: string, priceCents: number | null): Promise<PhlebActionResult> {
  return patchAppt(caseId, { price_cents: priceCents }, `Cost set to ${formatPrice(priceCents)}`);
}

/** Confirm the appointment with the patient or the vendor. */
export async function confirmAppointment(
  caseId: string,
  party: "patient" | "vendor",
): Promise<PhlebActionResult> {
  const col = party === "patient" ? "patient_confirmed_at" : "vendor_confirmed_at";
  return patchAppt(caseId, { [col]: new Date().toISOString() }, `${party === "patient" ? "Patient" : "Vendor"} confirmed the appointment`);
}

/** Sample drawn → status 'drawn'. */
export async function markDrawn(caseId: string): Promise<PhlebActionResult> {
  return patchAppt(caseId, { drawn_at: new Date().toISOString(), status: "drawn" }, "Sample drawn");
}

/** Post-draw "smooth & complete" QA confirmed with vendor + patient → 'completed'. */
export async function confirmCompleted(caseId: string): Promise<PhlebActionResult> {
  return patchAppt(
    caseId,
    { completed_confirmed_at: new Date().toISOString(), status: "completed" },
    "Confirmed smooth & complete with vendor + patient",
  );
}

/** Cancel the appointment (folds back to Needs Scheduling for re-booking). */
export async function cancelAppointment(caseId: string, reason?: string): Promise<PhlebActionResult> {
  const r = (reason ?? "").trim();
  return patchAppt(
    caseId,
    { status: "canceled", canceled_at: new Date().toISOString() },
    r ? `Appointment canceled — ${r}` : "Appointment canceled",
  );
}

/** Free-text notes for the appointment (quiet — no activity-log line). */
export async function setApptNotes(caseId: string, notes: string): Promise<PhlebActionResult> {
  const user = await requireSignedIn();
  const actor = user.email ?? "staff";
  const db = getSupabaseAdmin();
  let apptId: string;
  try {
    apptId = await getOrCreateOpenAppt(db, caseId, actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No appointment" };
  }
  const { error } = await db
    .from("phlebotomy_appointments")
    .update({ notes: notes.trim() || null, updated_by: actor })
    .eq("id", apptId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs");
  return { ok: true };
}

// ── Forward req to the vendor ───────────────────────────────────────────────
function isoToUs(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

/**
 * Email the requisition to the phlebotomy vendor so the draw team knows exactly
 * what to collect. When the staff uploads a req PDF that file is forwarded;
 * otherwise each lab's auto-filled req is attached (a lab with no template is
 * just listed in the body). Stamps req_forwarded_at + logs the send (history).
 */
export async function forwardReq(
  caseId: string,
  vendorEmail: string,
  uploaded?: { filename: string; base64: string },
): Promise<PhlebActionResult> {
  const user = await requireSignedIn();
  const actor = user.email ?? "staff";
  const to = vendorEmail.trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "Enter a valid vendor email." };
  }
  // Guard the inline upload against Vercel's ~4.5MB body limit (base64 ≈ 4/3×).
  if (uploaded?.base64 && uploaded.base64.length > 5_000_000) {
    return { ok: false, error: "Uploaded req is too large (max ~3.5 MB)." };
  }
  const db = getSupabaseAdmin();

  // Ensure a trackable appointment exists up front so the stamp at the end lands
  // by id (a case_id+neq update would silently no-op if none existed).
  let apptId: string;
  try {
    apptId = await getOrCreateOpenAppt(db, caseId, actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No appointment" };
  }

  const { data: c } = await db
    .from("lab_cases")
    .select("patient_name, patient_email, collection_date")
    .eq("id", caseId)
    .maybeSingle();
  if (!c) return { ok: false, error: "Case not found." };

  // The draw covers every lab the patient is doing that day. Gather the sibling
  // lab cases and attach each one's auto-filled req (best-effort — a lab with no
  // template is just listed in the body). Reuses the shared resolver + generator
  // so the forwarded forms match the req-form modal exactly.
  const { data: sibRows } = await db
    .from("lab_cases")
    .select("id, lab_name")
    .eq("patient_email", c.patient_email)
    .eq("collection_date", c.collection_date)
    .is("deleted_at", null);
  const sibs = ((sibRows ?? []) as Array<{ id: string; lab_name: string }>).filter(
    (s) => !SERVICE_LAB.test(s.lab_name),
  );
  const labNames = [...new Set(sibs.map((s) => s.lab_name))].sort((a, b) => a.localeCompare(b));

  // An uploaded req takes precedence — it's the explicit form the staff wants
  // sent. With no upload, auto-fill each lab's req (best-effort).
  const attachments: { filename: string; content: Buffer }[] = [];
  if (uploaded?.base64) {
    const safeName = (uploaded.filename || "requisition.pdf").replace(/[^\w.\- ]/g, "_");
    attachments.push({ filename: safeName, content: Buffer.from(uploaded.base64, "base64") });
  } else {
    for (const s of sibs) {
      try {
        const resolved = await resolveReqForm(s.id);
        if (!resolved) continue;
        const req = await generateReqForm(s.id, resolved.data);
        if (req.ok) attachments.push({ filename: req.filename, content: Buffer.from(req.pdfBase64, "base64") });
      } catch {
        /* skip this lab's form */
      }
    }
  }

  const cfg = envEmailConfig();
  if (!cfg.fromEmail) return { ok: false, error: "ALERT_FROM_EMAIL is not configured." };
  // Honor the test redirect so dev sends never reach a real vendor.
  const sendTo = cfg.testRedirect ? [cfg.testRedirect] : [to];

  const drawList = labNames.length ? labNames.join(", ") : "(see attached)";
  const collLine = c.collection_date ? `\nRequested collection date: ${isoToUs(c.collection_date)}` : "";
  const subject = `Phlebotomy requisition — ${c.patient_name}`;
  const lines = [
    `Hi,`,
    ``,
    `Please find the requisition(s) for the upcoming mobile blood draw.`,
    ``,
    `Patient: ${c.patient_name}`,
    `Labs to draw: ${drawList}${collLine}`,
    attachments.length
      ? `\n${attachments.length} requisition form${attachments.length === 1 ? "" : "s"} attached.`
      : `\n(Requisition forms will follow separately.)`,
    ``,
    `Thank you,`,
    cfg.practiceName || "The clinic",
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#18181b">${lines
    .map((l) => (l ? `<p style="margin:0 0 8px">${l.replace(/\n/g, "<br/>")}</p>` : "<br/>"))
    .join("")}</div>`;

  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: cfg.fromHeader,
      to: sendTo,
      replyTo: cfg.replyTo,
      subject,
      html,
      text,
      attachments: attachments.length ? attachments : undefined,
    });
    if (result.error) throw new Error(result.error.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed";
    return { ok: false, error: msg };
  }

  await db
    .from("phlebotomy_appointments")
    .update({ req_forwarded_at: new Date().toISOString(), updated_by: actor })
    .eq("id", apptId);
  const formNote = uploaded?.base64
    ? `uploaded req (${attachments[0]?.filename ?? "file"})`
    : `${attachments.length} form${attachments.length === 1 ? "" : "s"} auto-attached`;
  await logPhleb(
    db,
    caseId,
    actor,
    `Req forwarded to ${to} — ${labNames.length} lab${labNames.length === 1 ? "" : "s"}, ${formNote}`,
    {
      vendorEmail: to,
      labs: labNames,
      attached: attachments.length,
      uploaded: Boolean(uploaded?.base64),
      redirected: Boolean(cfg.testRedirect),
    },
  );
  revalidatePath("/labs");
  return { ok: true };
}

/** Past req-forward sends for a draw (the section-4 history). Pulled from the
 *  activity log (phlebotomy_event rows carrying a vendorEmail in meta). */
export async function listReqForwards(
  caseId: string,
): Promise<Array<{ at: string; vendorEmail: string; note: string }>> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("lab_events")
    .select("created_at, note, meta")
    .eq("case_id", caseId)
    .eq("kind", "phlebotomy_event")
    .order("created_at", { ascending: false });
  return ((data ?? []) as Array<{ created_at: string; note: string | null; meta: Record<string, unknown> | null }>)
    .filter((e) => typeof e.meta?.vendorEmail === "string")
    .map((e) => ({
      at: e.created_at,
      vendorEmail: String(e.meta?.vendorEmail ?? ""),
      note: e.note ?? "",
    }));
}
