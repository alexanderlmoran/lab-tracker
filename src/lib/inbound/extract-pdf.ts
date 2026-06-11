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
  // pdfjs's Node fake-worker loads pdf.worker.mjs through a VARIABLE dynamic
  // import the file tracer can't see, so the file never ships to Vercel. This
  // literal import both gets it traced into the bundle and pre-registers the
  // worker (globalThis.pdfjsWorker), so the untraceable path never runs. Must
  // stay AFTER the pdf-parse import — pdf.mjs installs the DOMMatrix polyfill
  // the worker code needs.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    return text.length > 50_000 ? text.slice(0, 50_000) + "\n[…truncated]" : text;
  } finally {
    await parser.destroy();
  }
}
