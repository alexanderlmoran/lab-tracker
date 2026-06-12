"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import { mintPdfUploadUrl, storagePathBelongsToCase } from "@/lib/labs/pdf-upload";
import type { ActionResult } from "@/lib/types";

export type ProbeCandidate = {
  ref: string | null;
  pdfBytes: number;
  pdfFilename: string | null;
  resultIssuedAt: string | null;
  /** Set by name-search probes (e.g. Access): collection date + portal status,
   *  so staff can pick the right accession from a multi-result history. */
  collectionDate?: string | null;
  status?: string | null;
};

export type ProbeResult = {
  lab: string;
  labKey: string;
  name: string;
  found: ProbeCandidate[];
  /** When called with `stage: true`, how many PDFs were pulled + staged onto
   * the case for review. 0 = nothing staged (not found, or ambiguous). */
  staged: number;
  errors: Array<{ caseId: string; message: string }>;
};

/**
 * Find a result for a case by PATIENT NAME, no accession needed. Proxies the
 * worker's POST /probe/:lab?name= so staff can proactively verify + clear
 * accession-less cards. Returns the candidate result(s) WITHOUT posting; an
 * empty `found` doubles as a "not ready in the portal yet" signal.
 *
 * With `stage: true` (backlog #6 "search for lab to post"), the worker doesn't
 * just check — it PULLS the found PDF and stages it onto this case for review
 * (same postResultReady path the scheduled scrape uses), so a stuck Pending-
 * Upload card gets its review PDF in one click. `staged` reports how many landed.
 */
export async function probeCaseResult(input: {
  caseId: string;
  stage?: boolean;
}): Promise<ActionResult<ProbeResult>> {
  await requireSignedIn();

  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("id, patient_name, patient_dob, lab_name, lab_external_ref")
    .eq("id", input.caseId)
    .maybeSingle();
  if (!caseRow) return { ok: false, error: "Case not found" };

  const labKey = probeKeyForLab(caseRow.lab_name as string);
  if (!labKey) {
    return {
      ok: false,
      error: `No scraper for lab "${caseRow.lab_name}" — can't find a result by name.`,
    };
  }

  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return { ok: false, error: "WORKER_SHARED_SECRET not configured" };
  const base = (process.env.WORKER_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");

  const params = new URLSearchParams({ name: String(caseRow.patient_name ?? "") });
  if (caseRow.patient_dob) params.set("dob", String(caseRow.patient_dob));
  if (input.stage) {
    params.set("stageCaseId", input.caseId);
    if (caseRow.lab_external_ref) params.set("acc", String(caseRow.lab_external_ref));
  }
  const url = `${base}/probe/${encodeURIComponent(labKey)}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(180_000), // live portal scrape can be slow
    });
    const json = (await res.json().catch(() => null)) as
      | (ProbeResult & { error?: string })
      | { error?: string }
      | null;
    if (!res.ok) {
      const msg = json && "error" in json && json.error ? json.error : `worker returned ${res.status}`;
      return { ok: false, error: `worker: ${msg}` };
    }
    const data = (json ?? {}) as Partial<ProbeResult>;
    if (input.stage && (data.staged ?? 0) > 0) {
      // A PDF landed in the review step — refresh the board/card so it shows.
      revalidatePath("/labs");
      revalidatePath(`/labs/${input.caseId}`);
    }
    return {
      ok: true,
      data: {
        lab: data.lab ?? labKey,
        labKey,
        name: data.name ?? String(caseRow.patient_name ?? ""),
        found: data.found ?? [],
        staged: data.staged ?? 0,
        errors: data.errors ?? [],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worker unreachable at ${base} — is it running? (${msg})` };
  }
}

/**
 * Write an accession (lab_external_ref) onto a case — the "clear the card"
 * follow-up after a name-probe surfaces the right result. Logs the change so
 * the activity log shows it came from the probe flow. Once set, the normal
 * deterministic scrape → PB-upload pipeline can take the case the rest of the
 * way.
 */
export async function setCaseAccession(input: {
  caseId: string;
  accession: string;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const accession = input.accession.trim();
  if (!accession) return { ok: false, error: "Accession is required" };

  const db = getSupabaseAdmin();
  const { data: current } = await db
    .from("lab_cases")
    .select("lab_external_ref")
    .eq("id", input.caseId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Case not found" };

  const from = (current as { lab_external_ref: string | null }).lab_external_ref;
  if (from === accession) return { ok: true };

  const { error } = await db
    .from("lab_cases")
    .update({ lab_external_ref: accession })
    .eq("id", input.caseId);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert({
    case_id: input.caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    meta: { changes: { lab_external_ref: { from, to: accession } }, source: "name_probe" },
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${input.caseId}`);
  return { ok: true };
}

/**
 * Manually attach a result PDF to a case — the universal fallback for labs with
 * no scraper (Kennedy Krieger, MembersPanel, Custom…), un-downloadable reports
 * (Vibrant EBOO), or any portal the scrape can't reach. Mirrors the worker's
 * postResultReady → /api/worker/result-ready staging: upload to the lab-pdfs
 * bucket, insert a lab_case_pdfs row, and tick step 4 (+ cascade 1/2/3). Does
 * NOT touch the accession (manual uploads aren't a portal match).
 *
 * AUTO-APPROVES (Alex, 2026-06-11): the human picked this exact file for this
 * exact case — a second Approve click was redundant. The PDF goes straight to
 * the PB queue and the card lands in Complete Uploaded when the PB worker
 * confirms. If the auto-approve/enqueue step fails, the card falls back to
 * Pending Upload where the normal Approve button still works.
 */
/** Mint a signed Storage upload URL for a manual result-PDF upload. The browser
 *  PUTs the file STRAIGHT to Storage with this, then calls recordResultPdf — so
 *  the bytes never pass through a server action (Vercel caps those at ~4.5 MB and
 *  crashed the page on large reports). */
export async function getManualUploadUrl(
  caseId: string,
  filename: string,
): Promise<ActionResult<{ uploadUrl: string; storagePath: string }>> {
  await requireSignedIn();
  try {
    const minted = await mintPdfUploadUrl(caseId, filename);
    return { ok: true, data: minted };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't start the upload" };
  }
}

/** Record a result PDF that's ALREADY in Storage (uploaded via a signed URL from
 *  getManualUploadUrl, or by uploadResultPdf below): stage the row, tick the
 *  steps, auto-approve + enqueue the PB upload (the uploader is the reviewer). No
 *  PDF bytes pass through here, so any size works. */
export async function recordResultPdf(input: {
  caseId: string;
  storagePath: string;
  filename: string;
  sizeBytes: number;
  isPartial?: boolean;
}): Promise<ActionResult<{ pdfId: string }>> {
  const user = await requireSignedIn();
  const db = getSupabaseAdmin();
  if (!storagePathBelongsToCase(input.storagePath, input.caseId)) {
    return { ok: false, error: "storagePath not under this case" };
  }

  const { data: kase } = await db
    .from("lab_cases")
    .select("id, lab_external_ref")
    .eq("id", input.caseId)
    .maybeSingle();
  if (!kase) return { ok: false, error: "Case not found" };

  const filename = (input.filename.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "manual.pdf");
  const source = `manual:${user.email ?? "staff"}`;
  const { data: pdfRow, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .insert({
      case_id: input.caseId,
      storage_path: input.storagePath,
      source,
      external_ref: (kase as { lab_external_ref: string | null }).lab_external_ref ?? "manual",
      filename,
      size_bytes: input.sizeBytes,
      is_partial: input.isPartial ?? false,
      result_issued_at: null,
      attached_by: source,
    })
    .select("id")
    .single();
  if (pdfErr || !pdfRow) return { ok: false, error: `Couldn't stage the PDF: ${pdfErr?.message ?? "unknown"}` };

  // A PDF arriving = results received → tick step 4 (+ cascade 1/2/3), or step 2
  // (+1) for a partial. Mirrors result-ready / setStepCompleted(cascadePrior).
  const target = input.isPartial ? "step2_partial_received" : "step4_complete_received";
  const cascade = input.isPartial
    ? ["step1_sample_sent"]
    : ["step1_sample_sent", "step2_partial_received", "step3_partial_uploaded"];
  const { data: steps } = await db
    .from("lab_cases")
    .select("step1_sample_sent, step2_partial_received, step3_partial_uploaded, step4_complete_received")
    .eq("id", input.caseId)
    .single();
  const s = (steps as Record<string, boolean> | null) ?? {};
  const updates: Record<string, boolean> = {};
  if (!s[target]) updates[target] = true;
  for (const c of cascade) if (!s[c]) updates[c] = true;
  if (Object.keys(updates).length > 0) {
    await db.from("lab_cases").update(updates).eq("id", input.caseId);
  }

  // Auto-approve + enqueue for PB (mirrors result-ready's autoApprove block):
  // the uploader IS the reviewer. Best-effort — a failure here leaves the PDF
  // staged in Pending Upload with the normal Approve button as the fallback.
  let autoQueued = false;
  const { error: auditErr } = await db.from("lab_case_audit").insert({
    case_id: input.caseId,
    pdf_id: pdfRow.id,
    action: "approve",
    actor_label: user.email ?? "staff",
    notes: "auto-approved (manual upload — uploader is the reviewer)",
  });
  if (!auditErr) {
    const { error: jobErr } = await db.from("pb_upload_jobs").upsert(
      {
        case_id: input.caseId,
        pdf_id: pdfRow.id,
        status: "queued",
        last_error: null,
        claimed_at: null,
        finished_at: null,
      },
      { onConflict: "case_id,pdf_id" },
    );
    autoQueued = !jobErr;
  }

  await db.from("lab_events").insert({
    case_id: input.caseId,
    kind: "case_edited",
    actor: source,
    note: autoQueued
      ? `Result PDF uploaded manually (${filename}, ${input.sizeBytes} bytes) — auto-approved, queued for PracticeBetter`
      : `Result PDF uploaded manually (${filename}, ${input.sizeBytes} bytes) — auto-queue failed, waiting in Pending Upload for Approve`,
    meta: { pdf_id: pdfRow.id, manual: true, auto_queued: autoQueued },
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${input.caseId}`);
  return { ok: true, data: { pdfId: pdfRow.id } };
}

/** Legacy/small manual upload: bytes come through the action, we upload + record.
 *  The manual button now uses the direct-to-storage flow (getManualUploadUrl +
 *  recordResultPdf) so large PDFs never hit the action body cap; this remains for
 *  any caller that still sends base64. */
export async function uploadResultPdf(input: {
  caseId: string;
  pdfBase64: string;
  filename: string;
  isPartial?: boolean;
}): Promise<ActionResult<{ pdfId: string }>> {
  await requireSignedIn();
  const db = getSupabaseAdmin();

  const { data: kase } = await db.from("lab_cases").select("id").eq("id", input.caseId).maybeSingle();
  if (!kase) return { ok: false, error: "Case not found" };

  const bytes = Buffer.from(input.pdfBase64, "base64");
  if (bytes.length === 0) return { ok: false, error: "Empty file." };
  if (bytes.indexOf("%PDF-") < 0) return { ok: false, error: "That file isn't a PDF." };

  const filename = (input.filename.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "manual.pdf");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `${input.caseId}/${ts}-${filename}`;
  const { error: upErr } = await db.storage
    .from("lab-pdfs")
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  return recordResultPdf({ caseId: input.caseId, storagePath, filename, sizeBytes: bytes.length, isPartial: input.isPartial });
}
