import { getSupabaseAdmin } from "@/utils/supabase/admin";

export const LAB_PDF_BUCKET = "lab-pdfs";

/**
 * Mint a one-time signed Supabase Storage upload URL for a case's result PDF.
 *
 * The uploader (the worker, or the browser for a manual upload) PUTs the PDF
 * bytes STRAIGHT to `uploadUrl` — never through the app — then records the
 * result by `storagePath`. This bypasses Next's server-action body limit AND
 * Vercel's hard ~4.5 MB serverless request-body cap, which silently dropped
 * large reports (a 4.2 MB Vibrant EBOO report → ~5.6 MB base64 → over the cap,
 * so the worker fetched it fine but couldn't hand it to the app). Direct-to-
 * storage means any size posts.
 *
 * `signedUrl` from createSignedUploadUrl is already a full PUT-able URL.
 */
export async function mintPdfUploadUrl(
  caseId: string,
  filename: string,
): Promise<{ uploadUrl: string; storagePath: string }> {
  const db = getSupabaseAdmin();
  const { data: kase } = await db
    .from("lab_cases")
    .select("id")
    .eq("id", caseId)
    .maybeSingle();
  if (!kase) throw new Error("case not found");

  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "result.pdf";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `${caseId}/${ts}-${safe}`;

  const { data, error } = await db.storage
    .from(LAB_PDF_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (error || !data) {
    throw new Error(`signed upload url: ${error?.message ?? "unknown"}`);
  }
  return { uploadUrl: data.signedUrl, storagePath };
}

/** Guard: a recorded storagePath must live under the case's own folder, so a
 *  caller can never attach a file staged for a different case. Paths are minted
 *  as `<caseId>/<ts>-<file>` (see mintPdfUploadUrl). */
export function storagePathBelongsToCase(storagePath: string, caseId: string): boolean {
  return storagePath.startsWith(`${caseId}/`);
}
