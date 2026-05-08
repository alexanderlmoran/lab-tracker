import type { LabCase } from "@/lib/types";

export type LabRemoteStatus =
  | "pending"
  | "received"
  | "in_progress"
  | "partial_ready"
  | "complete"
  | "error"
  | "unknown";

export type LabPullResult = {
  status: LabRemoteStatus;
  /** Free-form message from the lab API (shown in audit log). */
  message?: string;
  /** Lab-side reference number, if returned. */
  externalRef?: string;
  /** When the lab last updated this order (ISO). */
  remoteUpdatedAt?: string;
};

export type LabAdapter = {
  /** lab_name match — used to pick the right adapter for a case. */
  labKey: string;
  displayName: string;
  /** True if credentials are configured in env. */
  isConfigured: () => boolean;
  /** Fetch the latest status for one case. */
  pullStatus: (row: LabCase) => Promise<LabPullResult>;
};
