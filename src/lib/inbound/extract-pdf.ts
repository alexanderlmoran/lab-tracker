import "server-only";

/** Extract plain text from a PDF buffer. Uses pdf-parse, which wraps pdfjs.
 * Truncates to keep prompt sizes bounded. */
export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  // pdf-parse is CommonJS — dynamic import avoids ESM resolution edge cases.
  const mod = (await import("pdf-parse")) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const result = await mod.default(Buffer.from(buf));
  const text = (result.text ?? "").trim();
  return text.length > 50_000 ? text.slice(0, 50_000) + "\n[…truncated]" : text;
}
