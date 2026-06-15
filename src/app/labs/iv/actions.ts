"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";

/** A row of the IV Charting board — the staff-facing subset of iv_sessions. */
export type IvSessionRow = {
  id: string;
  zenoti_appointment_id: string;
  patient_full_name: string | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_email: string | null;
  service_name: string;
  kind: string;
  is_add_on: boolean;
  weber: boolean;
  template_hint: string | null;
  therapist_name: string | null;
  session_date: string;
  start_at: string | null;
  pc_infusion_number: number | null;
  pc_vial_count: string | null;
  charting_status: string;
  pb_note_id: string | null;
  pb_client_record_id: string | null;
  chart: Record<string, unknown>;
};

const IV_COLS = [
  "id",
  "zenoti_appointment_id",
  "patient_full_name",
  "patient_first_name",
  "patient_last_name",
  "patient_email",
  "service_name",
  "kind",
  "is_add_on",
  "weber",
  "template_hint",
  "therapist_name",
  "session_date",
  "start_at",
  "pc_infusion_number",
  "pc_vial_count",
  "charting_status",
  "pb_note_id",
  "pb_client_record_id",
  "chart",
].join(", ");

/** All IV sessions for one clinic day (YYYY-MM-DD), earliest start first. */
export async function listIvSessions(date: string): Promise<IvSessionRow[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("iv_sessions")
    .select(IV_COLS)
    .eq("session_date", date)
    .order("start_at", { ascending: true });
  if (error) {
    // Surface the message so the page can show "table not created yet" vs a
    // real failure. Don't swallow — the board distinguishes the two.
    throw new Error(error.message);
  }
  return (data ?? []) as unknown as IvSessionRow[];
}

// ── Charting form ──────────────────────────────────────────────────────
// The staff-entered overlay stored in iv_sessions.chart (jsonb). Standard
// components come from the PB template at post time; this captures vitals,
// add-ons + lot/exp, and the IV-start details. Loose by design (tracks the
// template) — the few sub-objects below are the common IV-note fields.

export type Vitals = {
  bp?: string;
  spo2?: string;
  temp?: string;
  hr?: string;
  resp?: string;
};
export type ComponentRow = {
  name?: string;
  standardDose?: string;
  addOnDose?: string;
  lot?: string;
  exp?: string;
  /** Which PB component matrix (section index) this row belongs to — set at prefill
   *  for multi-section templates so the post routes it back to the right section. */
  section?: number;
};
export type IvChart = {
  assessment?: {
    initialCheckIn?: boolean;
    risksDiscussed?: boolean;
    consentSigned?: boolean;
    intakeSigned?: boolean;
    historyDiscussed?: boolean;
  };
  preVitals?: Vitals;
  postVitals?: Vitals;
  ivStart?: { cath?: "24" | "22" | "20" | "18" | "picc" | "midline" };
  attempts?: "1" | "2" | "already";
  location?: "right_antecubital" | "left_antecubital" | "left_arm" | "";
  infusionFlowingWell?: boolean;
  components?: ComponentRow[];
  /** Intramuscular medication given alongside the IV (e.g. B12), if any. */
  imMedication?: { name?: string; dose?: string; location?: string };
  imShotGiven?: boolean;
  /** Provider who performed the IV (defaults to the Zenoti therapist). */
  provider?: string;
  infusionReaction?: { occurred?: boolean; note?: string };
  ivRemoval?: boolean;
  /** Phosphatidylcholine infusions only. */
  pc?: { infusionNumber?: number | null; vialCount?: string };
  /** Free-text notes the charting nurse adds. */
  notes?: string;
};

export type IvSessionDetail = IvSessionRow & {
  patient_phone: string | null;
  zenoti_note: string | null;
};

export async function getIvSession(id: string): Promise<IvSessionDetail | null> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("iv_sessions")
    .select(`${IV_COLS}, patient_phone, zenoti_note`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as IvSessionDetail) ?? null;
}

/** The cached component rows for a template (product label + standard dose),
 *  used to PREFILL a new chart's Components table. Source:
 *  iv_template_refs.components, populated from the PB reference note by
 *  worker/scripts/iv-cache-template-components.ts. Matched on a NORMALIZED
 *  template_hint (mirrors /api/worker/iv-post/next so "Myers’ Cocktail" ==
 *  "Myers' Cocktail"). No __base_iv__ fallback — prefill only on a specific
 *  template match; an unmatched IV keeps the single blank row (staff add via the
 *  picker) rather than dumping the generic base catalog. */
export async function getTemplateComponents(templateHint: string | null): Promise<ComponentRow[]> {
  await requireSignedIn();
  const want = normalizeTemplateHint(templateHint);
  if (!want) return [];
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("iv_template_refs").select("template_hint, components");
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((r) => normalizeTemplateHint(r.template_hint as string) === want);
  const comps = (hit?.components ?? []) as unknown;
  return Array.isArray(comps) ? (comps as ComponentRow[]) : [];
}

/** Normalize a template_hint for matching: straighten curly quotes, collapse
 *  whitespace, lowercase. Mirror of the same fn in /api/worker/iv-post/next. */
function normalizeTemplateHint(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Save the charting form. markReady flips status pending→ready (charted,
 *  awaiting the Approve/post step). Never touches Zenoti-synced columns. */
export async function saveIvChart(
  id: string,
  chart: IvChart,
  opts: { markReady?: boolean } = {},
): Promise<{ ok: true }> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  const patch: Record<string, unknown> = { chart, updated_by: user.email };
  if (opts.markReady) patch.charting_status = "ready";
  const { error } = await db.from("iv_sessions").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath(`/labs/iv/${id}`);
  revalidatePath("/labs/iv");
  return { ok: true };
}

// ── Held-for-review ────────────────────────────────────────────────────
/** A post job the worker held (low-confidence match, ambiguous, etc.) for a
 *  human to resolve. */
export type HeldIvPost = {
  jobId: string;
  sessionId: string;
  serviceName: string;
  patientName: string | null;
  sessionDate: string;
  matchScore: number | null;
  matchReason: string | null;
  candidateId: string | null; // best PB candidate the matcher found (if any)
  isTie: boolean; // reason flags a too-close runner-up → don't offer 1-click confirm
};

export async function listHeldIvPosts(): Promise<HeldIvPost[]> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("iv_post_jobs")
    .select("id, session_id, match_score, match_reason, pb_client_record_id, iv_sessions(service_name, patient_full_name, session_date, kind)")
    .eq("status", "held")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? [])
    // EBOO/EBO2 are charted by hand in PB — they hold by design, not a problem to
    // review, so keep them out of the "needs review" list.
    .filter((j: Record<string, unknown>) => ((j.iv_sessions ?? {}) as Record<string, unknown>).kind !== "ebo")
    .map((j: Record<string, unknown>) => {
    const s = (j.iv_sessions ?? {}) as Record<string, unknown>;
    const reason = (j.match_reason as string | null) ?? null;
    return {
      jobId: j.id as string,
      sessionId: j.session_id as string,
      serviceName: (s.service_name as string) ?? "—",
      patientName: (s.patient_full_name as string | null) ?? null,
      sessionDate: (s.session_date as string) ?? "",
      matchScore: (j.match_score as number | null) ?? null,
      matchReason: reason,
      candidateId: (j.pb_client_record_id as string | null) ?? null,
      isTie: !!reason && /runner-up too close/i.test(reason),
    };
  });
}

/** Resolve a hold: a human vouched for the matched PB patient → stamp it on the
 *  session and re-queue. The worker then posts to that record (skips the gate). */
export async function confirmIvMatchAndPost(sessionId: string, clientRecordId: string): Promise<{ ok: true }> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error: uErr } = await db.from("iv_sessions").update({ pb_client_record_id: clientRecordId }).eq("id", sessionId);
  if (uErr) throw new Error(uErr.message);
  await enqueueIvPost(sessionId);
  return { ok: true };
}

/** Mark an IV as already charted by hand in PB — dismiss it from review + the
 *  board (status "skipped"), and drop its post job so the sweep won't re-enqueue. */
export async function markIvAlreadyDone(sessionId: string): Promise<{ ok: true }> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  await db.from("iv_post_jobs").delete().eq("session_id", sessionId);
  const { error } = await db.from("iv_sessions").update({ charting_status: "skipped" }).eq("id", sessionId);
  if (error) throw new Error(error.message);
  revalidatePath("/labs/iv");
  return { ok: true };
}

/** Queue a session for PB posting. The worker grades the patient match and
 *  auto-posts at >=95, else holds for review. One job per session (re-queues
 *  a prior failed/held one). */
export async function enqueueIvPost(sessionId: string): Promise<{ ok: true }> {
  await requireSignedIn();
  const db = getSupabaseAdmin();
  const { error } = await db.from("iv_post_jobs").upsert(
    { session_id: sessionId, status: "queued", last_error: null, finished_at: null, claimed_at: null },
    { onConflict: "session_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath(`/labs/iv/${sessionId}`);
  revalidatePath("/labs/iv");
  return { ok: true };
}
