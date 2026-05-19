import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default is 1 MB. Bumped so patient-seed CSV uploads and bulk
      // import commits don't get truncated when batches are large.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
