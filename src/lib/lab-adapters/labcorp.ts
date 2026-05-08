import type { LabAdapter } from "./types";

// Stub. Wire actual LabCorp API calls once credentials are provisioned.
// Docs entry point (verify when you get access): https://www.labcorp.com/connect
export const labcorpAdapter: LabAdapter = {
  labKey: "LabCorp",
  displayName: "LabCorp",
  isConfigured: () =>
    Boolean(process.env.LABCORP_API_KEY && process.env.LABCORP_API_BASE),
  async pullStatus(row) {
    if (!labcorpAdapter.isConfigured()) {
      return {
        status: "unknown",
        message:
          "LabCorp adapter not configured (missing LABCORP_API_KEY/LABCORP_API_BASE).",
      };
    }
    void row;
    return {
      status: "unknown",
      message: "LabCorp adapter is a stub — implementation pending credentials.",
    };
  },
};
