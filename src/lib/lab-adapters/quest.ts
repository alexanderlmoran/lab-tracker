import type { LabAdapter } from "./types";

// Stub. Wire actual Quest API calls once credentials are provisioned.
// Docs entry point (verify when you get access): https://quanum.com/api
export const questAdapter: LabAdapter = {
  labKey: "Quest",
  displayName: "Quest Diagnostics",
  isConfigured: () =>
    Boolean(process.env.QUEST_API_KEY && process.env.QUEST_API_BASE),
  async pullStatus(row) {
    if (!questAdapter.isConfigured()) {
      return {
        status: "unknown",
        message: "Quest adapter not configured (missing QUEST_API_KEY/QUEST_API_BASE).",
      };
    }
    // TODO: real call. Expected shape:
    // GET ${QUEST_API_BASE}/orders/{trackingNumber}
    // Authorization: Bearer ${QUEST_API_KEY}
    // Map response → LabPullResult.
    void row;
    return {
      status: "unknown",
      message: "Quest adapter is a stub — implementation pending credentials.",
    };
  },
};
