// pdfjs-dist ships no .d.ts next to its legacy build, so map that subpath to the
// package's main type declarations. We import the LEGACY build at runtime (the
// modern build trips "Object.defineProperty called on non-object" under the
// bundler / in non-DOM fallbacks); the API surface is identical.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
