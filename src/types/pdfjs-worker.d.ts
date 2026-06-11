// Imported for its side effect only (registers globalThis.pdfjsWorker so
// pdfjs never hits its untraceable variable dynamic import — see
// src/lib/inbound/extract-pdf.ts). The deep path ships no types.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
