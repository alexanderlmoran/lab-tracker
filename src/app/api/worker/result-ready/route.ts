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
import { lastNameKey } from "@/lib/labs/patient-name";
import { extractPdfText } from "@/lib/inbound/extract-pdf";
import { extractDobFromText, extractSexFromText, nameLooksLike } from "@/lib/labs/pdf-identity";

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

/** Best-effort: pull a patient name out of the report's PDF TEXT so we can
 * persist the report's identity even when the scraper exposed no portal name.
 * CHEAP only — reuses the existing `extractPdfText` (pdf-parse, no AI call) and
 * a couple of label regexes. Returns null on anything uncertain; the caller
 * then leaves report_patient_name null and relies on the portal/UI name + the
 * accession tie. We never add a new parser or an Anthropic call here. */
type ReportIdentity = { name: string | null; dob: string | null; sex: "M" | "F" | null };

async function bestEffortReportIdentity(pdfBytes: Buffer): Promise<ReportIdentity> {
  let text: string;
  try {
    // Copy into a standalone ArrayBuffer (Buffer.buffer is a shared pool slice,
    // and its type widens to SharedArrayBuffer); extractPdfText wants ArrayBuffer.
    const ab = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(ab).set(pdfBytes);
    text = await extractPdfText(ab);
  } catch {
    return { name: null, dob: null, sex: null }; // unreadable / encrypted — don't throw
  }
  if (!text) return { name: null, dob: null, sex: null };
  // DOB + sex are printed in the same top banner as the name (cheap regex, no AI).
  const dob = extractDobFromText(text.slice(0, 4000));
  const sex = extractSexFromText(text.slice(0, 4000));
  // Look at the report's first page only — the patient banner is at the top of
  // every lab format, and labels deeper in the doc (provider, billing) would be
  // false hits. Match common "Patient/Name: <Name>" banners; a name is 1–4
  // capitalized tokens or "LAST, FIRST".
  const head = text.slice(0, 4000);
  const patterns = [
    /\bPatient(?:\s+Name)?\s*[:#]?\s*([A-Z][A-Za-z'’.-]+(?:,?\s+[A-Z][A-Za-z'’.-]+){0,3})/,
    /\bName\s*[:#]\s*([A-Z][A-Za-z'’.-]+(?:,?\s+[A-Z][A-Za-z'’.-]+){0,3})/,
  ];
  let name: string | null = null;
  for (const re of patterns) {
    const m = head.match(re);
    const candidate = m?.[1]?.trim();
    // Only trust it if it yields a real last-name key (filters "Patient: See
    // attached" style noise that wouldn't compare meaningfully anyway).
    if (candidate && lastNameKey(candidate)) {
      name = candidate;
      break;
    }
  }
  return { name, dob, sex };
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
    .select("id, lab_external_ref, patient_name, patient_email, patient_dob, patient_sex, collection_date")
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

  // FAIL CLOSED: require a POSITIVE patient tie BEFORE the PDF is attached. The
  // worker pairs caseId↔PDF on its side, but a scraper that returns the wrong
  // row (or a card whose accession was mis-keyed) must NOT silently attach
  // another patient's result (incident: Salvatore Didonato's 007254433 landed
  // on Negin Etemad's case). Two independent ties make a stage safe:
  //   - corroborated: the portal patient name matched this case's patient. A
  //     MISMATCH already 409'd at the gate above, so reaching here WITH a name
  //     set means it matched. (No name ⇒ the scraper exposes none ⇒ unverified.)
  //   - accessionMatches: the report's accession equals the case's stored ref —
  //     an exact-order tie, the patient-safe match the recipe/scrapers rely on.
  // Neither ⇒ we cannot prove the report belongs to this patient ⇒ QUARANTINE:
  // do NOT attach, log loudly, return 409. (Allowed paths are unaffected:
  // accession-exact stages, and name-corroborated stages incl. the Vinay-Mittal
  // accession-adopt case where the name matched but the accession differs.)
  const corroborated = Boolean(parsed.portalPatientName); // mismatches already 409'd above
  const accessionMatches =
    !!kase.lab_external_ref && parsed.labExternalRef === kase.lab_external_ref;
  if (!accessionMatches && !corroborated) {
    await db.from("lab_events").insert({
      case_id: parsed.caseId,
      kind: "case_edited",
      actor: parsed.source,
      note: `QUARANTINED: report accession ${parsed.labExternalRef} could not be tied to this case's patient (no portal name + accession mismatch) — NOT attached`,
      meta: {
        quarantined_external_ref: parsed.labExternalRef,
        case_external_ref: kase.lab_external_ref,
        portal_patient: parsed.portalPatientName ?? null,
      },
    });
    return NextResponse.json(
      { ok: false, error: "unverified report — quarantined" },
      { status: 409 },
    );
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

  // Persist the REPORT's own patient identity on the PDF row so the Approve
  // screen + the PB-upload claim guard can later compare it against the case
  // patient. Order of trust:
  //   1. portalPatientName — the portal-row name the scraper matched (already
  //      proven to last-name-match this case at the gate above; the strongest
  //      tie we have).
  //   2. best-effort PDF-text extraction — ONLY when we hold the bytes (inline
  //      path) and no portal name was given; cheap, no AI, returns null on
  //      anything uncertain.
  //   3. null — unknown; downstream falls back to the portal/UI name and the
  //      accession tie. Null never blocks an upload.
  let reportPatientName: string | null = parsed.portalPatientName?.trim() || null;
  let pdfDob: string | null = null;
  let pdfSex: "M" | "F" | null = null;
  if (pdfBytes) {
    const ident = await bestEffortReportIdentity(pdfBytes);
    if (!reportPatientName) reportPatientName = ident.name;
    pdfDob = ident.dob;
    pdfSex = ident.sex;
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
      report_patient_name: reportPatientName,
    })
    .select("id")
    .single();
  if (pdfErr || !pdfRow) {
    return NextResponse.json(
      { ok: false, error: `pdf row insert: ${pdfErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Close DOB/sex gaps from the most authoritative source — the result itself.
  // Only when the case lacks them AND a name we trust (portal name, already
  // gate-verified above, else the PDF's own banner name) matches this case's
  // patient — never copy a DOB off a wrong-patient report. Cascade to the same
  // person's other DOB-less cases (same NAME + email — not email alone, since
  // families share an email and a sibling's DOB must not bleed across).
  if (
    pdfDob &&
    !kase.patient_dob &&
    reportPatientName &&
    nameLooksLike(reportPatientName, kase.patient_name as string)
  ) {
    const patch: Record<string, unknown> = { patient_dob: pdfDob };
    if (pdfSex && !kase.patient_sex) patch.patient_sex = pdfSex;
    await db.from("lab_cases").update(patch).eq("id", parsed.caseId);
    const email = kase.patient_email as string | null;
    if (email) {
      await db
        .from("lab_cases")
        .update({ patient_dob: pdfDob })
        .eq("patient_name", kase.patient_name as string)
        .eq("patient_email", email)
        .is("patient_dob", null);
    }
    await db.from("lab_events").insert({
      case_id: parsed.caseId,
      kind: "case_edited",
      actor: "worker:result-ready",
      note: `DOB ${pdfDob}${pdfSex ? ` / sex ${pdfSex}` : ""} captured from the result PDF`,
    });
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
    // `corroborated` computed above. With the fail-closed gate in place an
    // accession mismatch can only reach here when the name corroborated (else
    // it was quarantined), so the else-branch is now a defensive backstop.
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

  // POLICY (2026-06): NO automatic posting to PracticeBetter. Auto-posting is
  // OFF unless explicitly re-enabled via AUTO_POST_ENABLED=true. When a caller
  // asks to auto-approve but the policy suppresses it, we STILL stage the PDF
  // (above) so staff can review + post it by hand — we just never queue a PB
  // upload. The suppression is logged so the activity log shows why a capture
  // that used to auto-post now waits in Pending Upload. This is the single
  // server-side chokepoint (every scraper/probe/engine path posts here), so the
  // policy holds regardless of what any worker still sends as autoApprove.
  const autoPostEnabled = process.env.AUTO_POST_ENABLED === "true";
  const effectiveAutoApprove = parsed.autoApprove && autoPostEnabled;
  if (parsed.autoApprove && !autoPostEnabled) {
    await db.from("lab_events").insert({
      case_id: parsed.caseId,
      kind: "case_edited",
      actor: parsed.source,
      note: `Auto-post suppressed by policy (AUTO_POST_ENABLED off) — PDF staged for manual review, not queued to PB (accession ${parsed.labExternalRef}).`,
      meta: { pdf_id: pdfRow.id, external_ref: parsed.labExternalRef, confidence: parsed.confidence ?? null },
    });
  }

  // Reconciliation engine auto-approve: a high-confidence capture is approved +
  // enqueued for PB upload without a human click (mirrors approvePdf). The
  // existing pb-upload-worker drains the queue and flips step5 on success. A
  // low-confidence capture skips this block and waits in Pending Upload.
  if (effectiveAutoApprove) {
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

  return NextResponse.json({ ok: true, pdfId: pdfRow.id, storagePath, autoApproved: effectiveAutoApprove });
}
