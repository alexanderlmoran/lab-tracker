// Which carrier a lab's outbound sample ships via. Cyrex uses UPS today; every
// other lab uses FedEx. An explicit tracking_carrier (set when staff enter the
// tracking #) wins over the lab-name default. Centralized so the pickup flow and
// any future UPS-pickup integration share one source of truth.

export type ShipCarrier = "fedex" | "ups";

export function carrierForCase(c: {
  lab_name?: string | null;
  tracking_carrier?: string | null;
}): ShipCarrier {
  const tc = (c.tracking_carrier ?? "").toLowerCase();
  if (tc.includes("ups")) return "ups";
  if (tc.includes("fedex") || tc.includes("fdx")) return "fedex";
  return /cyrex/i.test(c.lab_name ?? "") ? "ups" : "fedex";
}

export const CARRIER_LABEL: Record<ShipCarrier, string> = {
  fedex: "FedEx",
  ups: "UPS",
};
