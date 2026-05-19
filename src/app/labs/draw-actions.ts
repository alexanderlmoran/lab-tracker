"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult, DrawNote, LabCase } from "@/lib/types";

// Same rule the migration uses to bucket cases into shared draws:
// lowercased email when present, lowercased name otherwise.
function patientKeyFor(row: Pick<LabCase, "patient_email" | "patient_name">): string {
  const email = (row.patient_email ?? "").trim().toLowerCase();
  if (email) return email;
  return (row.patient_name ?? "").trim().toLowerCase();
}

async function loadCaseSlim(
  caseId: string,
): Promise<Pick<LabCase, "id" | "patient_email" | "patient_name" | "collection_date"> | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_cases")
    .select("id, patient_email, patient_name, collection_date")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Pick<LabCase, "id" | "patient_email" | "patient_name" | "collection_date"> | null) ?? null;
}

export async function getDrawNote(caseId: string): Promise<DrawNote | null> {
  await requireSignedIn();
  const c = await loadCaseSlim(caseId);
  if (!c || !c.collection_date) return null;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("draw_notes")
    .select("*")
    .eq("patient_key", patientKeyFor(c))
    .eq("collection_date", c.collection_date)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DrawNote | null) ?? null;
}

const UpdateInput = z.object({
  caseId: z.string().uuid(),
  body: z.string().trim().max(4000),
});

export async function updateDrawNote(input: {
  caseId: string;
  body: string;
}): Promise<ActionResult<{ siblingCount: number }>> {
  const user = await requireSignedIn();
  const parsed = UpdateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const c = await loadCaseSlim(parsed.data.caseId);
  if (!c) return { ok: false, error: "Case not found" };
  if (!c.collection_date) {
    return {
      ok: false,
      error: "This case has no collection date — set one to use shared notes.",
    };
  }
  const db = getSupabaseAdmin();
  const key = patientKeyFor(c);

  // Upsert keyed on (patient_key, collection_date) — the unique index lets
  // every sibling case share the row without a manual select-then-update.
  const { error } = await db
    .from("draw_notes")
    .upsert(
      {
        patient_key: key,
        collection_date: c.collection_date,
        body: parsed.data.body,
        updated_by: user.email ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "patient_key,collection_date" },
    );
  if (error) return { ok: false, error: error.message };

  // Count sibling cases sharing this draw so the UI can say "applies to 5 cards".
  // Match on the same rule as patient_key: prefer email, fall back to name.
  const siblingQuery = db
    .from("lab_cases")
    .select("id", { count: "exact", head: true })
    .eq("collection_date", c.collection_date)
    .is("deleted_at", null);
  const email = (c.patient_email ?? "").trim();
  const { count } = await (email
    ? siblingQuery.ilike("patient_email", email)
    : siblingQuery.ilike("patient_name", c.patient_name ?? ""));

  revalidatePath("/labs");
  revalidatePath(`/labs/${parsed.data.caseId}`);
  return { ok: true, data: { siblingCount: count ?? 1 } };
}

const AttemptInput = z.object({
  caseId: z.string().uuid(),
  note: z.string().trim().max(200).optional(),
});

export async function recordContactAttempt(input: {
  caseId: string;
  note?: string;
}): Promise<ActionResult<{ openAttempts: number }>> {
  const user = await requireSignedIn();
  const parsed = AttemptInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { caseId, note } = parsed.data;
  const db = getSupabaseAdmin();

  const { error } = await db.from("lab_events").insert({
    case_id: caseId,
    kind: "contact_attempted",
    actor: user.email ?? "admin",
    note: note && note.length ? note : null,
  });
  if (error) return { ok: false, error: error.message };

  const open = await openAttemptCount(caseId);
  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true, data: { openAttempts: open } };
}

export async function markPatientReached(caseId: string): Promise<ActionResult> {
  const user = await requireSignedIn();
  if (!z.string().uuid().safeParse(caseId).success) {
    return { ok: false, error: "Invalid case id" };
  }
  const db = getSupabaseAdmin();
  const { error } = await db.from("lab_events").insert({
    case_id: caseId,
    kind: "contact_reached",
    actor: user.email ?? "admin",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/labs");
  revalidatePath(`/labs/${caseId}`);
  return { ok: true };
}

/**
 * Open attempts = contact_attempted events strictly after the most recent
 * contact_reached event. Returns 0 if the patient has been reached since
 * the last attempt, or there are no attempts at all.
 */
async function openAttemptCount(caseId: string): Promise<number> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("lab_events")
    .select("kind, created_at")
    .eq("case_id", caseId)
    .in("kind", ["contact_attempted", "contact_reached"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ kind: string; created_at: string }>;
  let count = 0;
  for (const r of rows) {
    if (r.kind === "contact_reached") break;
    if (r.kind === "contact_attempted") count++;
  }
  return count;
}

export type CardCounts = {
  openAttempts: number;
  emailCount: number;
};

/**
 * Batched counts for the kanban — one round-trip for all visible cases.
 * Returns a record keyed by caseId. Missing entries default to zero on the
 * caller side.
 */
export async function getCardCountsForCases(
  caseIds: string[],
): Promise<Record<string, CardCounts>> {
  await requireSignedIn();
  if (caseIds.length === 0) return {};
  const db = getSupabaseAdmin();

  const [eventsRes, emailsRes] = await Promise.all([
    db
      .from("lab_events")
      .select("case_id, kind, created_at")
      .in("case_id", caseIds)
      .in("kind", ["contact_attempted", "contact_reached"])
      .order("created_at", { ascending: false }),
    db
      .from("email_logs")
      .select("case_id")
      .in("case_id", caseIds),
  ]);
  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (emailsRes.error) throw new Error(emailsRes.error.message);

  const result: Record<string, CardCounts> = {};
  for (const id of caseIds) result[id] = { openAttempts: 0, emailCount: 0 };

  // Events come back newest-first; per case, walk until we hit a reached event.
  const seenReached = new Set<string>();
  for (const ev of eventsRes.data ?? []) {
    const row = ev as { case_id: string; kind: string };
    if (seenReached.has(row.case_id)) continue;
    if (row.kind === "contact_reached") {
      seenReached.add(row.case_id);
      continue;
    }
    if (row.kind === "contact_attempted") {
      result[row.case_id].openAttempts++;
    }
  }
  for (const e of emailsRes.data ?? []) {
    const row = e as { case_id: string };
    if (result[row.case_id]) result[row.case_id].emailCount++;
  }
  return result;
}
