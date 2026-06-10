// Pickup / ready-to-ship lifecycle predicates — the single source of truth for
// "which cards have a sample packed and waiting at the clinic." Shared by the
// `ready_to_ship` kanban column (getColumnFor), the Schedule-pickup button, and
// the Tracking board's "Pending pickup" column so they never disagree.
//
// THE RULE: a card is "ready to ship" once a tracking # (the return label) is
// attached but step 1 ("Sample sent") hasn't ticked yet. Step 1 ticks when
// FedEx actually scans the package — refresh-core advances it on PU/in_transit
// (and on delivery). Entering a tracking # NO LONGER ticks step 1 (that auto-
// tick was decoupled), which is exactly what lets a card rest in this state.
//
// Why not gate on tracking_status? FedEx purges history after ~90 days, leaving
// long-sent cards at status "unknown" — keying off that made already-shipped
// cards (and kit-out tracking numbers) look ready, which was the "Schedule
// pickup (109)" bug. Step 1 is the durable workflow signal; tracking_status is
// the volatile carrier signal.

import type { LabCase } from "@/lib/types";

type ShipState = Pick<LabCase, "tracking_number" | "step1_sample_sent">;
type LifecycleState = ShipState &
  Pick<LabCase, "archived_at" | "deleted_at" | "pickup_confirmation">;

/** Sample packed with a return label, not yet handed to / scanned by the carrier. */
export function isReadyToShip(c: ShipState): boolean {
  return Boolean(c.tracking_number) && !c.step1_sample_sent;
}

/** Ready to ship and no pickup booked yet → a candidate for "Schedule pickup". */
export function awaitingPickup(c: LifecycleState): boolean {
  return !c.archived_at && !c.deleted_at && isReadyToShip(c) && !c.pickup_confirmation;
}

/** Pickup booked but the carrier hasn't scanned the package yet (step 1 unticked). */
export function pickupPending(c: LifecycleState): boolean {
  return !c.archived_at && !c.deleted_at && Boolean(c.pickup_confirmation) && isReadyToShip(c);
}
