// Overlay engine: fetch a lab's blank req-form template from storage and stamp
// the resolved per-patient values onto it (positioned text — the templates are
// flat scans with no AcroForm fields). Returns the filled PDF bytes.

import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ReqFormSpec, ReqFormData } from "./types";

const BUCKET = "req-form-templates";

export async function fillReqForm(spec: ReqFormSpec, data: ReqFormData): Promise<Uint8Array> {
  const db = getSupabaseAdmin();
  const { data: file, error } = await db.storage.from(BUCKET).download(spec.templateKey);
  if (error || !file) {
    throw new Error(`req-form template "${spec.templateKey}" not found: ${error?.message ?? "missing"}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  for (const [field, pos] of Object.entries(spec.fields)) {
    if (!pos) continue;
    let val = data[field as keyof ReqFormData];
    if (val == null || val === "") continue;
    if (pos.maxChars && val.length > pos.maxChars) val = val.slice(0, pos.maxChars);
    const page = pages[pos.page ?? 0];
    if (!page) continue;
    const { height } = page.getSize();
    page.drawText(String(val), {
      x: pos.x,
      y: height - pos.yTop, // yTop is from the top of the page
      size: pos.size ?? 26,
      font,
      color: rgb(0, 0, 0.65), // blue-black, clearly an overlay vs the printed form
    });
  }
  return pdf.save();
}
