import type { NextConfig } from "next";

// @napi-rs/canvas + its platform binary (linux-x64 on Vercel) — pdfjs's
// DOMMatrix polyfill, loaded via createRequire so the tracer can't see it.
const PDF_RUNTIME_FILES = [
  "node_modules/@napi-rs/canvas/**",
  "node_modules/@napi-rs/canvas-*/**",
];

const nextConfig: NextConfig = {
  // pdfjs-dist (wrapped by pdf-parse) breaks when the bundler re-processes it
  // ("Object.defineProperty called on non-object" — the same trap the req-form
  // calibrator hit client-side, see PLAYBOOK). Load both natively from
  // node_modules on the server instead of bundling.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  // pdfjs loads @napi-rs/canvas via createRequire (its DOMMatrix polyfill) —
  // invisible to Vercel's file tracer, so deployed functions threw
  // "ReferenceError: DOMMatrix is not defined" on every PDF extraction while
  // localhost (full node_modules) worked. Force the package (and its platform
  // binary, linux-x64 on Vercel) into the two functions that extract PDF text.
  outputFileTracingIncludes: {
    "/labs/inbox": PDF_RUNTIME_FILES,
    "/api/worker/gmail-sync": PDF_RUNTIME_FILES,
  },
  experimental: {
    serverActions: {
      // Default is 1 MB. Bumped so patient-seed CSV uploads, bulk import
      // commits, and manual result-PDF uploads aren't truncated. NOTE: this
      // governs LOCAL/Next only — on Vercel the platform hard-caps serverless
      // request bodies at ~4.5 MB regardless, so large PDFs must go
      // direct-to-storage (client → Supabase), not through the server action.
      bodySizeLimit: "30mb",
    },
  },
};

export default nextConfig;
