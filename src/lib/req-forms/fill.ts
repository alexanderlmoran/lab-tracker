// Overlay engine: fetch a lab's blank req-form template from storage and stamp
// the resolved per-patient values onto it (positioned text — the templates are
// flat scans with no AcroForm fields). Returns the filled PDF bytes.

import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { loadOverrides, mergeFields } from "./overrides";
import type { ReqFormSpec, ReqFormData } from "./types";

const BUCKET = "req-form-templates";

export async function fillReqForm(
  spec: ReqFormSpec,
  data: ReqFormData,
  customValues: Record<string, string> = {},
): Promise<Uint8Array> {
  const db = getSupabaseAdmin();
  const { data: file, error } = await db.storage.from(BUCKET).download(spec.templateKey);
  if (error || !file) {
    throw new Error(`req-form template "${spec.templateKey}" not found: ${error?.message ?? "missing"}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  const stamp = (val: string, x: number, yTop: number, size: number, pageIdx: number) => {
    const page = pages[pageIdx];
    if (!page) return;
    page.drawText(val, { x, y: page.getSize().height - yTop, size, font, color: rgb(0, 0, 0) });
  };

  // Live calibrator overrides win over the static spec, field-by-field.
  const ov = await loadOverrides(spec.templateKey);
  const fields = mergeFields(spec.fields, ov.fields);
  for (const [field, pos] of Object.entries(fields)) {
    if (!pos) continue;
    let val = data[field as keyof ReqFormData];
    if (val == null || val === "") continue;
    if (pos.maxChars && val.length > pos.maxChars) val = val.slice(0, pos.maxChars);
    stamp(String(val), pos.x, pos.yTop, pos.size ?? 26, pos.page ?? 0);
  }

  // User-added custom fields — value typed per-case in the dialog.
  for (const cf of ov.custom) {
    const val = customValues[cf.key];
    if (val == null || val === "") continue;
    stamp(String(val), cf.x, cf.yTop, cf.size ?? 26, cf.page ?? 0);
  }
  return pdf.save();
}
