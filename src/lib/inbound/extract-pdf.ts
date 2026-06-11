import "server-only";

/** Extract plain text from a PDF buffer. Truncates to keep prompt sizes
 * bounded.
 *
 * pdf-parse v2 is a CLASS API (`new PDFParse(...).getText()`) with NO default
 * export — the old v1-style `mod.default(buffer)` call returned undefined and
 * THREW on every attachment, which the sync loop swallowed per-part, so every
 * email ingested with zero extracted text and Claude had nothing to parse. */
export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    return text.length > 50_000 ? text.slice(0, 50_000) + "\n[…truncated]" : text;
  } finally {
    await parser.destroy();
  }
}
