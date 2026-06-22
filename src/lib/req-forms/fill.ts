// Overlay engine: fetch a lab's blank req-form template from storage and stamp
// the resolved per-patient values onto it (positioned text — the templates are
// flat scans with no AcroForm fields). Returns the filled PDF bytes.

import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { loadOverrides, mergeFields } from "./overrides";
import type { ReqFormSpec, ReqFormData, ReqField, FieldPos } from "./types";

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

  // A position is usable only if it lands within its page — a stale calibrator
  // override can push a field off-page, where it "stamps" but is invisible
  // (the suspected cause of Kennedy's missing order #). When that happens we
  // fall back to the static spec position rather than stamping into the void.
  const onPage = (pos: FieldPos): boolean => {
    const page = pages[pos.page ?? 0];
    if (!page) return false;
    const { width, height } = page.getSize();
    return pos.x >= 0 && pos.x <= width && pos.yTop >= 0 && pos.yTop <= height;
  };

  // Live calibrator overrides win over the static spec, field-by-field.
  const ov = await loadOverrides(spec.templateKey);
  const fields = mergeFields(spec.fields, ov.fields);
  for (const [field, pos] of Object.entries(fields)) {
    if (!pos) continue;
    let val = data[field as keyof ReqFormData];
    if (val == null || val === "") continue;
    let place: FieldPos = pos;
    if (!onPage(place)) {
      const specPos = spec.fields[field as ReqField];
      if (specPos && onPage(specPos)) place = specPos;
      else continue; // no on-page position to stamp
    }
    if (place.maxChars && val.length > place.maxChars) val = val.slice(0, place.maxChars);
    stamp(String(val), place.x, place.yTop, place.size ?? 26, place.page ?? 0);
  }

  // User-added custom fields — value typed per-case in the dialog.
  for (const cf of ov.custom) {
    const val = customValues[cf.key];
    if (val == null || val === "") continue;
    stamp(String(val), cf.x, cf.yTop, cf.size ?? 26, cf.page ?? 0);
  }
  return pdf.save();
}
