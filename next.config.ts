import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist (wrapped by pdf-parse) breaks when the bundler re-processes it
  // ("Object.defineProperty called on non-object" — the same trap the req-form
  // calibrator hit client-side, see PLAYBOOK). Load both natively from
  // node_modules on the server instead of bundling.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  experimental: {
    serverActions: {
      // Default is 1 MB. Bumped so patient-seed CSV uploads and bulk
      // import commits don't get truncated when batches are large.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
