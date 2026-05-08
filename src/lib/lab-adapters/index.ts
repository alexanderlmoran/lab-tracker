import type { LabAdapter, LabPullResult } from "./types";
import { labcorpAdapter } from "./labcorp";
import { questAdapter } from "./quest";

const ADAPTERS: LabAdapter[] = [questAdapter, labcorpAdapter];

export function getAdapterFor(labName: string): LabAdapter | null {
  const lower = labName.trim().toLowerCase();
  return (
    ADAPTERS.find((a) => a.labKey.toLowerCase() === lower) ??
    ADAPTERS.find((a) => lower.includes(a.labKey.toLowerCase())) ??
    null
  );
}

export function listAvailableAdapters(): Array<{
  labKey: string;
  displayName: string;
  configured: boolean;
}> {
  return ADAPTERS.map((a) => ({
    labKey: a.labKey,
    displayName: a.displayName,
    configured: a.isConfigured(),
  }));
}

export type { LabAdapter, LabPullResult };
