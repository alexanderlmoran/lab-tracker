// Lab portal scraper reports a downloaded result PDF.
//
// Endpoint matches the contract in worker/src/tracker-client.ts → postResultReady.
// Side effects:
//   1. Upload PDF bytes to Supabase Storage (bucket: lab-pdfs)
//   2. Insert lab_case_pdfs row (attached_by = source)
//   3. Set lab_cases.lab_external_ref if not already set (accession #)
//   4. Append a lab_events row for the activity log
//
// The card lands in the "Pending Upload" column automatically — that column
// is computed from "has a non-superseded PDF and no approve audit row yet."
// This endpoint does NOT toggle any step booleans. Step advancement comes
// from FedEx delivery polling, not from the PDF arrival itself.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { storagePathBelongsToCase } from "@/lib/labs/pdf-upload";
import { accessionSiblingIds } from "@/lib/labs/siblings";

export const dynamic = "force-dynamic";

const STORAGE_BUCKET = "lab-pdfs";

const Body = z.object({
  caseId: z.string().uuid(),
  labExternalRef: z.string().min(1),
  pdfFilename: z.string().min(1),
  // EITHER the inline bytes (legacy / small reports — decoded + uploaded here)
  // OR a storagePath the caller already PUT straight to Storage (large reports
  // — see /api/worker/result-upload-url; avoids the body-size cap that dropped
  // 4 MB+ PDFs). The refine() below requires one of the two.
  pdfBase64: z.string().min(1).optional(),
  storagePath: z.string().min(1).optional(),
  sizeBytes: z.number().int().positive().optional(),
  resultIssuedAt: z.string().optional(),
  /** Lab-reported sample-collection date (YYYY-MM-DD). When present and valid,
   * it's written onto the case as the authoritative collection_date — so the PB
   * "Date Ordered" reflects the real collection, not the scrape day. */
  collectionDate: z.string().optional(),
  source: z.string().min(1),
  /** When true, this is a partial result (auto-toggles step2 instead of step4). */
  isPartial: z.boolean().optional().default(false),
  /** Reconciliation engine: when true, the capture graded ≥ threshold, so we
   *  approve + enqueue the PB upload without waiting for a human Approve click.
   *  When false/omitted the PDF lands in Pending Upload for staff review. */
  autoApprove: z.boolean().optional().default(false),
  /** Capture-confidence score (0-100) recorded on the audit/flag for context. */
  confidence: z.number().optional(),
  /** The patient name as the PORTAL shows it for the matched report. When
   * present, the stage is REJECTED (409) unless the last name matches the
   * case's patient — the server-side guard against a scraper mismatch. */
  portalPatientName: z.string().optional(),
}).refine((d) => !!d.pdfBase64 || (!!d.storagePath && !!d.sizeBytes), {
  message: "pdfBase64, or storagePath + sizeBytes, is required",
});

// Loose last-name key for the patient-identity gate: "PADGETT, NICOLE" /
// "Marc Nicole Padgett" / "nicole padgett" all → "padgett". Lenient on
// purpose — first-name spelling variance must not block real results.
function lastNameKey(s: string): string {
  const clean = s.replace(/[^a-zA-Z, ]/g, " ").trim().toLowerCase();
  if (!clean) return "";
  if (clean.includes(",")) {
    return clean.split(",")[0]!.trim().split(/\s+/).pop() ?? "";
  }
  const parts = clean.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `bad body: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();

  const { data: kase, error: caseErr } = await db
    .from("lab_cases")
    .select("id, lab_external_ref, patient_name, collection_date")
    .eq("id", parsed.caseId)
    .single();
  if (caseErr || !kase) {
    return NextResponse.json({ ok: false, error: "case not found" }, { status: 404 });
  }

  // PATIENT-SAFETY GATE: the worker pairs caseId↔PDF on its side; this is the
  // server's independent check that the report belongs to this case's patient.
  // Mismatch = reject + a loud activity-log entry (NOT a silent skip).
  if (parsed.portalPatientName) {
    const portalKey = lastNameKey(parsed.portalPatientName);
    const caseKey = lastNameKey((kase.patient_name as string | null) ?? "");
    if (portalKey && caseKey && portalKey !== caseKey) {
      await db.from("lab_events").insert({
        case_id: parsed.caseId,
        kind: "case_edited",
        actor: parsed.source,
        note: `REJECTED a result PDF — portal patient "${parsed.portalPatientName}" does not match this case's patient "${kase.patient_name}" (accession ${parsed.labExternalRef})`,
        meta: { rejected_external_ref: parsed.labExternalRef, portal_patient: parsed.portalPatientName },
      });
      return NextResponse.json(
        { ok: false, error: "portal patient does not match case patient" },
        { status: 409 },
      );
    }
  }

  // Resolve the PDF's size (for dedup) + decode the bytes when sent inline.
  let sizeBytes: number;
  let pdfBytes: Buffer | null = null;
  if (parsed.storagePath) {
    if (!storagePathBelongsToCase(parsed.storagePath, parsed.caseId)) {
      return NextResponse.json({ ok: false, error: "storagePath not under this case" }, { status: 400 });
    }
    sizeBytes = parsed.sizeBytes!; // guaranteed present by the schema refine
  } else {
    pdfBytes = Buffer.from(parsed.pdfBase64!, "base64");
    if (pdfBytes.length === 0) {
      return NextResponse.json({ ok: false, error: "empty pdf" }, { status: 400 });
    }
    sizeBytes = pdfBytes.length;
  }

  // Idempotency: a retried post (lost response, hourly re-scrape before step5
  // flips) must not stage the same report twice — that meant a duplicate
  // lab_case_pdfs row and, on autoApprove, a SECOND queued PB upload. Same
  // case + accession + size + partial-flag on a live (un-superseded) row =
  // the same report; return the existing row. A partial that has GROWN (Access
  // back-fill) has a different size and still stages normally.
  const { data: dupRow } = await db
    .from("lab_case_pdfs")
    .select("id")
    .eq("case_id", parsed.caseId)
    .eq("external_ref", parsed.labExternalRef)
    .eq("size_bytes", sizeBytes)
    .eq("is_partial", parsed.isPartial ?? false)
    .is("superseded_at", null)
    .limit(1)
    .maybeSingle();
  if (dupRow) {
    return NextResponse.json({
      ok: true,
      pdfId: dupRow.id,
      deduped: true,
      autoApproved: false,
    });
  }

  // Ensure the file is in Storage: a storagePath caller already PUT it there
  // (direct-to-storage); an inline base64 caller's bytes get uploaded here.
  let storagePath: string;
  if (parsed.storagePath) {
    storagePath = parsed.storagePath;
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    storagePath = `${parsed.caseId}/${ts}-${parsed.pdfFilename}`;
    const { error: uploadErr } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, pdfBytes!, { contentType: "application/pdf", upsert: false });
    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: `storage upload: ${uploadErr.message}` },
        { status: 500 },
      );
    }
  }

  const { data: pdfRow, error: pdfErr } = await db
    .from("lab_case_pdfs")
    .insert({
      case_id: parsed.caseId,
      storage_path: storagePath,
      source: parsed.source,
      external_ref: parsed.labExternalRef,
      filename: parsed.pdfFilename,
      size_bytes: sizeBytes,
      is_partial: parsed.isPartial ?? false,
      result_issued_at: parsed.resultIssuedAt ?? null,
      attached_by: parsed.source,
    })
    .select("id")
    .single();
  if (pdfErr || !pdfRow) {
    return NextResponse.json(
      { ok: false, error: `pdf row insert: ${pdfErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Set — or CORRECT — the accession from the staged report. A manual name-probe
  // stages the real portal report even when the card's accession was wrong
  // (Vinay Mittal: card had 2606086632, portal had a different #) — adopt the
  // report's accession so future auto-pulls match and the record is right.
  // GUARDED: only adopt when the case had no accession, or when the portal
  // patient name corroborated above — an UNVERIFIED mismatch keeps the staff-
  // entered accession (overwriting it would re-point every future auto-pull
  // at the possibly-wrong order) and flags it in the activity log instead.
  if (kase.lab_external_ref !== parsed.labExternalRef) {
    const corroborated = Boolean(parsed.portalPatientName); // mismatches already 409'd above
    if (!kase.lab_external_ref || corroborated) {
      await db
        .from("lab_cases")
        .update({ lab_external_ref: parsed.labExternalRef })
        .eq("id", parsed.caseId);
    } else {
      await db.from("lab_events").insert({
        case_id: parsed.caseId,
        kind: "case_edited",
        actor: parsed.source,
        note: `Staged report's accession (${parsed.labExternalRef}) differs from the case's (${kase.lab_external_ref}) and the portal patient couldn't be verified — kept the existing accession; review at Approve.`,
        meta: { pdf_id: pdfRow.id, report_external_ref: parsed.labExternalRef },
      });
    }
  }

  // Date the case by the lab REPORT's own sample-collection date (the
  // authoritative "Date Collected", e.g. 06/03) so the PB post + the board show
  // the real draw — not the Zenoti booking date (which staff sometimes enter as
  // the order day, e.g. 06/18) and not the scrape day (the worker's "today"
  // fallback for a null date). OVERWRITE when it differs, which is SAFE here:
  // the Zenoti sync window is FORWARD-ONLY (today..+N, see zenoti-*-loop.ts), so
  // a PAST appointment is never re-fetched, and a re-sync of a still-open appt
  // matches by zenoti_appointment_id (cases/route.ts) — NOT collection_date — so
  // this can't desync the dedup or spawn a duplicate case. Value is already
  // YYYY-MM-DD from the scraper (parseFinalDate); the regex is a guard. Every
  // change is logged for traceability/reversibility.
  const reportCollDate = (parsed.collectionDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(reportCollDate) && reportCollDate !== (kase.collection_date ?? "")) {
    await db.from("lab_cases").update({ collection_date: reportCollDate }).eq("id", parsed.caseId);
    await db.from("lab_events").insert({
      case_id: parsed.caseId,
      kind: "case_edited",
      actor: parsed.source,
      note: kase.collection_date
        ? `Collection date corrected ${kase.collection_date} → ${reportCollDate} from the lab report (accession ${parsed.labExternalRef}).`
        : `Collection date set to ${reportCollDate} from the lab report (accession ${parsed.labExternalRef}).`,
      meta: { pdf_id: pdfRow.id, prev_collection_date: kase.collection_date, new_collection_date: reportCollDate },
    });
  }

  // A PDF arriving from the scraper IS the signal that the lab has the
  // results — no point making staff click step 4 (or step 2 for partial)
  // by hand. Match the form's setStepCompleted(cascadePrior:true) semantics:
  // when we set step 4, we also tick step 1 (and step 2/3 for partials) if
  // they're still false — otherwise the activity log shows step 4 done
  // with step 1 still open, which is structurally inconsistent.
  const stepToFlip = parsed.isPartial ? 2 : 4;
  const targetColumn =
    stepToFlip === 2 ? "step2_partial_received" : "step4_complete_received";

  // The cascade set for a step 4 auto-toggle: step 1, step 2, step 3
  // (per the form's "tick prior workflow steps" behavior). For step 2,
  // only step 1 cascades.
  const cascadeColumns: string[] =
    stepToFlip === 4
      ? ["step1_sample_sent", "step2_partial_received", "step3_partial_uploaded"]
      : ["step1_sample_sent"];

  const { data: caseSteps } = await db
    .from("lab_cases")
    .select(
      "step1_sample_sent, step2_partial_received, step3_partial_uploaded, step4_complete_received",
    )
    .eq("id", parsed.caseId)
    .single();

  const stepStateRow = (caseSteps as Record<string, boolean> | null) ?? {};
  const updates: Record<string, boolean> = {};
  const newlyToggled: { col: string; step: number }[] = [];

  const STEP_LABEL: Record<string, number> = {
    step1_sample_sent: 1,
    step2_partial_received: 2,
    step3_partial_uploaded: 3,
    step4_complete_received: 4,
  };

  if (!stepStateRow[targetColumn]) {
    updates[targetColumn] = true;
    newlyToggled.push({ col: targetColumn, step: stepToFlip });
  }
  for (const col of cascadeColumns) {
    if (!stepStateRow[col]) {
      updates[col] = true;
      newlyToggled.push({ col, step: STEP_LABEL[col] });
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.from("lab_cases").update(updates).eq("id", parsed.caseId);

    for (const t of newlyToggled) {
      await db.from("lab_events").insert({
        case_id: parsed.caseId,
        kind: "step_toggled",
        step: t.step,
        completed: true,
        actor: parsed.source,
        note:
          t.step === stepToFlip
            ? `Auto-set on result PDF arrival (${parsed.pdfFilename})`
            : `Auto-set by cascade from step ${stepToFlip}`,
        meta: {
          pdf_id: pdfRow.id,
          external_ref: parsed.labExternalRef,
          is_partial: parsed.isPartial ?? false,
        },
      });
    }
  }

  await db.from("lab_events").insert({
    case_id: parsed.caseId,
    kind: "case_edited",
    actor: parsed.source,
    note: `Result PDF attached (${parsed.pdfFilename}, ${sizeBytes} bytes)`,
    meta: {
      pdf_id: pdfRow.id,
      external_ref: parsed.labExternalRef,
      result_issued_at: parsed.resultIssuedAt ?? null,
      confidence: parsed.confidence ?? null,
    },
  });

  // Reconciliation engine auto-approve: a high-confidence capture is approved +
  // enqueued for PB upload without a human click (mirrors approvePdf). The
  // existing pb-upload-worker drains the queue and flips step5 on success. A
  // low-confidence capture skips this block and waits in Pending Upload.
  if (parsed.autoApprove) {
    // Same-accession merge: ONE PB post per physical order. A Vibrant order is
    // booked as N Zenoti panels → N cases sharing one accession, each staging
    // the SAME whole-order PDF — so without this each would auto-post a
    // duplicate labrequest. If a sibling case already has a PB job in flight or
    // done, this whole-order result is (or will be) on PB via that sibling, so
    // DON'T approve a duplicate. Leave the PDF in Pending Upload; the
    // post-success cascade supersedes it + completes this case when the sibling
    // posts. Reversible — nothing deleted; if the sibling's post fails the PDF
    // is still here for a human to approve. (Within one scrape run staging is
    // sequential under the per-lab scrape lock, so the check-then-enqueue can't
    // race itself; the residual is no worse than today and never data loss.)
    const group = await accessionSiblingIds(parsed.caseId);
    const siblings = group.filter((id) => id !== parsed.caseId);
    let coveredBySibling = false;
    if (siblings.length) {
      const { data: active } = await db
        .from("pb_upload_jobs")
        .select("id")
        .in("case_id", siblings)
        .in("status", ["queued", "claimed", "succeeded"])
        .limit(1)
        .maybeSingle();
      coveredBySibling = !!active;
    }
    if (coveredBySibling) {
      await db.from("lab_events").insert({
        case_id: parsed.caseId,
        kind: "case_edited",
        actor: parsed.source,
        note: `Auto-post skipped — a same-accession sibling is already posting/posted this order to PB (one merged post per accession ${parsed.labExternalRef}).`,
        meta: { pdf_id: pdfRow.id, external_ref: parsed.labExternalRef },
      });
    } else {
      const gradeNote =
        parsed.confidence != null
          ? `auto-approved by engine (capture grade ${parsed.confidence})`
          : "auto-approved by engine";
      const { error: auditErr } = await db.from("lab_case_audit").insert({
        case_id: parsed.caseId,
        pdf_id: pdfRow.id,
        action: "approve",
        actor_label: parsed.source,
        notes: gradeNote,
      });
      if (auditErr) {
        return NextResponse.json(
          { ok: false, error: `pdf staged but auto-approve audit failed: ${auditErr.message}`, pdfId: pdfRow.id },
          { status: 500 },
        );
      }
      const { error: jobErr } = await db.from("pb_upload_jobs").upsert(
        {
          case_id: parsed.caseId,
          pdf_id: pdfRow.id,
          status: "queued",
          last_error: null,
          claimed_at: null,
          finished_at: null,
        },
        { onConflict: "case_id,pdf_id" },
      );
      if (jobErr) {
        return NextResponse.json(
          { ok: false, error: `pdf approved but enqueue failed: ${jobErr.message}`, pdfId: pdfRow.id },
          { status: 500 },
        );
      }
    }
  }

  return NextResponse.json({ ok: true, pdfId: pdfRow.id, storagePath, autoApproved: parsed.autoApprove });
}
