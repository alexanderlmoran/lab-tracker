"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";

// ── Types exposed to the modal client component ──────────────────────

export type PendingPdf = {
  id: string;
  caseId: string;
  storagePath: string;
  filename: string | null;
  externalRef: string | null;
  isPartial: boolean;
  resultIssuedAt: string | null;
  attachedAt: string;
  attachedBy: string;
  /** Signed URL for the PDF, valid ~10 min from issue. */
  signedUrl: string;
  /** True if the most recent audit row for this PDF is `disapprove_upload_failed`. */
  hadUploadFailure: boolean;
  lastUploadError: string | null;
  /** Source-of-truth fields from the case row — used by the modal's
   * left-pane reference panel so staff can compare what the tracker thinks
   * this case should be against what's printed on the PDF. */
  caseRef: {
    patientName: string;
    patientDob: string | null;
    collectionDate: string | null;
    labName: string;
    caseExternalRef: string | null;
  };
};

// ── Helpers ──────────────────────────────────────────────────────────

const STORAGE_BUCKET = "lab-pdfs";
const SIGNED_URL_TTL_SECONDS = 600;

async function getSignedUrl(storagePath: string): Promise<string> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(`signed URL failed: ${error?.message ?? "unknown"}`);
  }
  return data.signedUrl;
}

/**
 * Returns the subset of input case_ids that currently have at least one
 * non-superseded PDF still flying through the upload pipeline. Used to lift
 * those cases into the "Pending Upload" Kanban column.
 *
 * "Still flying" = any of:
 *   - Awaiting staff Approve/Wrong-PDF click (no terminal audit row yet)
 *   - Approved, PB worker queued/in-flight (approve audit row exists but
 *     step5_complete_uploaded is still false — handled by the column
 *     branch's `!step5` gate in columns.ts, not here)
 *   - Approved, PB upload failed (disapprove_upload_failed audit row)
 *
 * The only thing that pops a PDF OUT of "Pending Upload" before step5 flips
 * is a `disapprove_wrong_pdf` audit — that means staff rejected the match
 * and the scraper needs to find a different PDF.
 */
export async function listCaseIdsWithPendingPdf(
  caseIds: string[],
): Promise<string[]> {
  if (caseIds.length === 0) return [];
  await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: pdfs, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .select("id, case_id")
    .in("case_id", caseIds)
    .is("superseded_at", null);
  if (pdfErr) throw new Error(pdfErr.message);
  if (!pdfs || pdfs.length === 0) return [];

  const pdfIds = pdfs.map((p) => p.id as string);
  // Only disapprove_wrong_pdf is a true terminal — it means the PDF was
  // the wrong one and the scraper needs another try. `approve` keeps the
  // card in pending_upload (semantically: "still working on getting this
  // onto PB"); the column will exit only when step5_complete_uploaded
  // flips true.
  const { data: terminal, error: auditErr } = await db
    .from("lab_case_audit")
    .select("pdf_id")
    .in("pdf_id", pdfIds)
    .eq("action", "disapprove_wrong_pdf");
  if (auditErr) throw new Error(auditErr.message);

  const terminalSet = new Set((terminal ?? []).map((t) => t.pdf_id as string));
  const pendingCaseIds = new Set<string>();
  for (const p of pdfs) {
    if (!terminalSet.has(p.id as string)) {
      pendingCaseIds.add(p.case_id as string);
    }
  }
  return [...pendingCaseIds];
}

// ── Reads ─────────────────────────────────────────────────────────────

/**
 * Returns the most recent non-superseded, non-approved PDF for a case, plus
 * a signed URL ready to embed in the review modal. Returns null when there's
 * nothing waiting on the human — the card isn't actually in pending_upload.
 */
export async function getPendingPdfForCase(
  caseId: string,
): Promise<PendingPdf | null> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: pdf, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .select("*")
    .eq("case_id", caseId)
    .is("superseded_at", null)
    .order("attached_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pdfErr) throw new Error(pdfErr.message);
  if (!pdf) return null;

  // Look for an approve audit row — if one exists, this PDF is already
  // approved (currently uploading or uploaded). Don't surface it as pending.
  const { data: approveRow } = await db
    .from("lab_case_audit")
    .select("id")
    .eq("pdf_id", pdf.id)
    .eq("action", "approve")
    .limit(1)
    .maybeSingle();
  if (approveRow) return null;

  // Was there a recent upload failure on this PDF? Show the Retry button.
  const { data: lastFailRow } = await db
    .from("lab_case_audit")
    .select("notes")
    .eq("pdf_id", pdf.id)
    .eq("action", "disapprove_upload_failed")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const signedUrl = await getSignedUrl(pdf.storage_path as string);

  // Pull the case's own truth-of-record fields so the modal can render a
  // side-by-side reference for staff verification.
  const { data: kase, error: caseErr } = await db
    .from("lab_cases")
    .select("patient_name, patient_dob, collection_date, lab_name, lab_external_ref")
    .eq("id", caseId)
    .single();
  if (caseErr || !kase) {
    throw new Error(`case lookup failed: ${caseErr?.message ?? "missing"}`);
  }

  return {
    id: pdf.id as string,
    caseId: pdf.case_id as string,
    storagePath: pdf.storage_path as string,
    filename: (pdf.filename as string | null) ?? null,
    externalRef: (pdf.external_ref as string | null) ?? null,
    isPartial: Boolean(pdf.is_partial),
    resultIssuedAt: (pdf.result_issued_at as string | null) ?? null,
    attachedAt: pdf.attached_at as string,
    attachedBy: pdf.attached_by as string,
    signedUrl,
    hadUploadFailure: Boolean(lastFailRow),
    lastUploadError: (lastFailRow?.notes as string | null) ?? null,
    caseRef: {
      patientName: kase.patient_name as string,
      patientDob: (kase.patient_dob as string | null) ?? null,
      collectionDate: (kase.collection_date as string | null) ?? null,
      labName: kase.lab_name as string,
      caseExternalRef: (kase.lab_external_ref as string | null) ?? null,
    },
  };
}

// ── Writes (audit-row–producing actions) ──────────────────────────────

const ApproveInput = z.object({
  pdfId: z.string().uuid(),
  caseId: z.string().uuid(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Staff approves the PDF: write audit row + enqueue a PB upload job. The
 * pb_upload_jobs row is what the worker poller drains — picks it up within
 * ~30s, runs uploadPdfToPb(), flips step5_complete_uploaded on success.
 */
export async function approvePdf(
  input: z.infer<typeof ApproveInput>,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = ApproveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const { error: auditErr } = await db.from("lab_case_audit").insert({
    case_id: parsed.data.caseId,
    pdf_id: parsed.data.pdfId,
    action: "approve",
    actor_user_id: user.id,
    actor_label: user.email ?? "staff",
    notes: parsed.data.notes,
  });
  if (auditErr) return { ok: false, error: auditErr.message };

  // Enqueue (or reset on Retry). The (case_id, pdf_id) unique index means a
  // prior failed job collides — upsert flips it back to queued.
  const { error: jobErr } = await db
    .from("pb_upload_jobs")
    .upsert(
      {
        case_id: parsed.data.caseId,
        pdf_id: parsed.data.pdfId,
        status: "queued",
        last_error: null,
        claimed_at: null,
        finished_at: null,
      },
      { onConflict: "case_id,pdf_id" },
    );
  if (jobErr) return { ok: false, error: `audit ok but enqueue failed: ${jobErr.message}` };

  revalidatePath("/labs");
  revalidatePath(`/labs/${parsed.data.caseId}`);
  return { ok: true };
}

const DisapproveInput = z.object({
  pdfId: z.string().uuid(),
  caseId: z.string().uuid(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Staff says the PDF is wrong (wrong patient, corrupt, or — the common case —
 * a stale result that isn't this case's draw). We supersede the PDF, blank
 * `lab_external_ref` so the scraper re-matches by name+DOB, AND remember the
 * rejected accession in `dismissed_refs` so the scraper SKIPS it next time and
 * keeps searching for a newer result instead of re-offering the same one.
 */
export async function disapproveWrongPdf(
  input: z.infer<typeof DisapproveInput>,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = DisapproveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();

  // Audit row first (immutable) — if the supersede update fails we still
  // have the staff intent recorded.
  const { error: auditErr } = await db.from("lab_case_audit").insert({
    case_id: parsed.data.caseId,
    pdf_id: parsed.data.pdfId,
    action: "disapprove_wrong_pdf",
    actor_user_id: user.id,
    actor_label: user.email ?? "staff",
    notes: parsed.data.notes,
  });
  if (auditErr) return { ok: false, error: auditErr.message };

  // Capture the rejected accession (from the PDF, falling back to the case)
  // and the current dismissed list BEFORE we supersede / blank anything.
  const { data: pdfRow } = await db
    .from("lab_case_pdfs")
    .select("external_ref")
    .eq("id", parsed.data.pdfId)
    .maybeSingle();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("lab_external_ref, dismissed_refs")
    .eq("id", parsed.data.caseId)
    .maybeSingle();
  const rejectedRef =
    ((pdfRow?.external_ref as string | null) ??
      (caseRow?.lab_external_ref as string | null) ??
      "")?.trim() || null;
  const existingDismissed = (caseRow?.dismissed_refs as string[] | null) ?? [];
  const dismissed_refs = rejectedRef
    ? Array.from(new Set([...existingDismissed, rejectedRef]))
    : existingDismissed;

  const supersedeReason = parsed.data.notes ?? "marked wrong by staff";
  const { error: pdfErr } = await db
    .from("lab_case_pdfs")
    .update({
      superseded_at: new Date().toISOString(),
      superseded_reason: supersedeReason,
    })
    .eq("id", parsed.data.pdfId);
  if (pdfErr) return { ok: false, error: pdfErr.message };

  // Blank the accession so the scraper re-matches by name+DOB next poll, and
  // record the rejected ref so it skips it and keeps searching.
  const { error: caseErr } = await db
    .from("lab_cases")
    .update({ lab_external_ref: null, dismissed_refs })
    .eq("id", parsed.data.caseId);
  if (caseErr) return { ok: false, error: caseErr.message };

  revalidatePath("/labs");
  revalidatePath(`/labs/${parsed.data.caseId}`);
  return { ok: true };
}

/**
 * Staff verified the result is ALREADY on the patient's PB chart (e.g. someone
 * posted it manually) — so don't re-upload. Supersede the staged PDF, mark
 * step 5 complete (card → Complete Uploaded), and log it. Stays silent on the
 * patient/Nadia emails, like the engine's already-on-PB advance: PB already has
 * it, so there's nothing new to announce.
 */
export async function markAlreadyUploaded(
  input: z.infer<typeof DisapproveInput>,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = DisapproveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();

  await db.from("lab_case_audit").insert({
    case_id: parsed.data.caseId,
    pdf_id: parsed.data.pdfId,
    action: "approve",
    actor_user_id: user.id,
    actor_label: user.email ?? "staff",
    notes: parsed.data.notes
      ? `Already on PB (no re-upload): ${parsed.data.notes}`
      : "Already on PB — marked complete without re-uploading",
  });

  // Discard the redundant staged PDF so it can't be re-surfaced / re-uploaded.
  const { error: pdfErr } = await db
    .from("lab_case_pdfs")
    .update({
      superseded_at: new Date().toISOString(),
      superseded_reason: "already on PB (staff marked complete)",
    })
    .eq("id", parsed.data.pdfId);
  if (pdfErr) return { ok: false, error: pdfErr.message };

  const { error: caseErr } = await db
    .from("lab_cases")
    .update({ step5_complete_uploaded: true })
    .eq("id", parsed.data.caseId);
  if (caseErr) return { ok: false, error: caseErr.message };

  await db.from("lab_events").insert({
    case_id: parsed.data.caseId,
    kind: "step_toggled",
    step: 5,
    completed: true,
    actor: user.email ?? "staff",
    note: "Marked complete — result already on PB (no re-upload, no email)",
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${parsed.data.caseId}`);
  return { ok: true };
}

/**
 * Staff clicks Retry after a prior upload failed. Logs intent — the worker
 * (PB uploader, future phase) is what actually re-runs the upload.
 */
export async function retryPdfUpload(
  input: z.infer<typeof DisapproveInput>,
): Promise<ActionResult> {
  const user = await requireSignedIn();
  const parsed = DisapproveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = getSupabaseAdmin();
  const { error } = await db.from("lab_case_audit").insert({
    case_id: parsed.data.caseId,
    pdf_id: parsed.data.pdfId,
    action: "retry_upload",
    actor_user_id: user.id,
    actor_label: user.email ?? "staff",
    notes: parsed.data.notes,
  });
  if (error) return { ok: false, error: error.message };

  // Reset the failed job back to queued. Worker picks it up next poll.
  const { error: jobErr } = await db
    .from("pb_upload_jobs")
    .update({ status: "queued", claimed_at: null, finished_at: null })
    .eq("case_id", parsed.data.caseId)
    .eq("pdf_id", parsed.data.pdfId);
  if (jobErr) return { ok: false, error: `audit ok but reset failed: ${jobErr.message}` };

  revalidatePath("/labs");
  revalidatePath(`/labs/${parsed.data.caseId}`);
  return { ok: true };
}
