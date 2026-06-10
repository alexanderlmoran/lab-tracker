// Pickup lifecycle predicates — which cards still need a carrier pickup
// booked, and which have one booked that the carrier hasn't honored yet.
// Shared by the Schedule-pickup button (candidate list + header count) and the
// Tracking board's "Pending pickup" column so the two never disagree.

import type { LabCase, TrackingStatus } from "@/lib/types";

// Statuses meaning the package has NOT been scanned into the carrier network.
// "unknown" covers both never-polled labels and old shipments FedEx has purged
// (~90 days), which is why awaitingPickup() also checks the workflow steps.
const NOT_IN_NETWORK = new Set<TrackingStatus | null>([null, "unknown", "pre_transit"]);

function notInNetwork(c: Pick<LabCase, "tracking_status" | "tracking_delivered_at">): boolean {
  return NOT_IN_NETWORK.has(c.tracking_status ?? null) && !c.tracking_delivered_at;
}

// Results came back → the sample reached the lab regardless of what tracking
// says (FedEx purges history, leaving stale "unknown" statuses on old cards).
function resultsAlreadyReceived(c: LabCase): boolean {
  return (
    c.step2_partial_received ||
    c.step3_partial_uploaded ||
    c.step4_complete_received ||
    c.step5_complete_uploaded ||
    c.step6_rof_scheduled ||
    c.step7_rof_completed ||
    c.step8_protocol_emailed ||
    c.step9_sales_followup
  );
}

/** Card needs a pickup booked: label exists, no pickup booked yet, package not
 * in the carrier network, and no results back. NOTE: step1_sample_sent can't be
 * used here — it auto-ticks the moment a tracking # is entered (see PLAYBOOK
 * "Advance step on tracking"), long before the package leaves the clinic. */
export function awaitingPickup(c: LabCase): boolean {
  return (
    Boolean(c.tracking_number) &&
    !c.pickup_confirmation &&
    notInNetwork(c) &&
    !resultsAlreadyReceived(c)
  );
}

/** Pickup booked but the carrier hasn't scanned the package yet. */
export function pickupPending(c: LabCase): boolean {
  return Boolean(c.pickup_confirmation) && notInNetwork(c) && !resultsAlreadyReceived(c);
}
