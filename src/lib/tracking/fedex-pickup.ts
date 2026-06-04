// FedEx Create Pickup client. Schedules a carrier pickup from the clinic via
// the FedEx Pickup API — same OAuth as tracking (getFedExAccessToken), so no
// browser scraping and no storing the fedex.com web login.
//
// ACTIVATION (all env vars; nothing is committed):
//   FEDEX_ACCOUNT_NUMBER         9-digit shipping account (NOT the web user id)
//   FEDEX_PICKUP_CONTACT_NAME    e.g. "Centner Wellness front desk"
//   FEDEX_PICKUP_CONTACT_PHONE   digits only
//   FEDEX_PICKUP_STREET          clinic street (one line)
//   FEDEX_PICKUP_CITY
//   FEDEX_PICKUP_STATE           2-letter, e.g. "FL"
//   FEDEX_PICKUP_ZIP
//   FEDEX_PICKUP_COUNTRY         default "US"
//   FEDEX_PICKUP_CLOSE_TIME      default "17:00:00" (when the clinic closes)
// Plus: the FedEx Developer project must have the "Pickup" product enabled
// (separate from Tracking). Until configured, schedulePickup() returns a clear
// "not configured" error rather than calling FedEx.

import { FedExError, fedexApiBase, getFedExAccessToken, isFedExConfigured } from "./fedex";

export type SchedulePickupInput = {
  /** YYYY-MM-DD the package is ready for pickup. */
  readyDate: string;
  /** HH:MM:SS local; defaults to 09:00:00. */
  readyTime?: string;
  packageCount?: number;
  /** "FDXE" (Express, default) or "FDXG" (Ground). */
  carrierCode?: "FDXE" | "FDXG";
  remarks?: string;
};

export type SchedulePickupResult = {
  ok: true;
  confirmationNumber: string;
  location?: string;
};

type PickupConfig = {
  account: string;
  contactName: string;
  contactPhone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  closeTime: string;
};

function readPickupConfig(): PickupConfig | { missing: string[] } {
  const fields: Array<[keyof PickupConfig, string | undefined, boolean]> = [
    ["account", process.env.FEDEX_ACCOUNT_NUMBER, true],
    ["contactName", process.env.FEDEX_PICKUP_CONTACT_NAME, true],
    ["contactPhone", process.env.FEDEX_PICKUP_CONTACT_PHONE, true],
    ["street", process.env.FEDEX_PICKUP_STREET, true],
    ["city", process.env.FEDEX_PICKUP_CITY, true],
    ["state", process.env.FEDEX_PICKUP_STATE, true],
    ["zip", process.env.FEDEX_PICKUP_ZIP, true],
    ["country", process.env.FEDEX_PICKUP_COUNTRY ?? "US", false],
    ["closeTime", process.env.FEDEX_PICKUP_CLOSE_TIME ?? "17:00:00", false],
  ];
  const missing = fields.filter(([, v, required]) => required && !v).map(([k]) => k);
  if (missing.length) return { missing };
  const cfg = Object.fromEntries(fields.map(([k, v]) => [k, v])) as unknown as PickupConfig;
  return cfg;
}

/** True when both the FedEx API and the pickup-location env are configured. */
export function isPickupConfigured(): boolean {
  return isFedExConfigured() && !("missing" in readPickupConfig());
}

export async function schedulePickup(input: SchedulePickupInput): Promise<SchedulePickupResult> {
  if (!isFedExConfigured()) {
    throw new FedExError("FedEx API not configured (FEDEX_API_KEY/SECRET/BASE).");
  }
  const cfg = readPickupConfig();
  if ("missing" in cfg) {
    throw new FedExError(`FedEx pickup not configured — set: ${cfg.missing.join(", ")}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.readyDate)) {
    throw new FedExError("readyDate must be YYYY-MM-DD");
  }

  const token = await getFedExAccessToken();
  const base = fedexApiBase();

  const body = {
    associatedAccountNumber: { value: cfg.account },
    originDetail: {
      pickupLocation: {
        contact: { personName: cfg.contactName, phoneNumber: cfg.contactPhone },
        address: {
          streetLines: [cfg.street],
          city: cfg.city,
          stateOrProvinceCode: cfg.state,
          postalCode: cfg.zip,
          countryCode: cfg.country,
        },
      },
      readyDateTimestamp: `${input.readyDate}T${input.readyTime ?? "09:00:00"}`,
      customerCloseTime: cfg.closeTime,
    },
    totalWeight: { units: "LB", value: Math.max(1, input.packageCount ?? 1) },
    packageCount: Math.max(1, input.packageCount ?? 1),
    carrierCode: input.carrierCode ?? "FDXE",
    remarks: input.remarks ?? "Lab sample pickup",
    countryRelationships: "DOMESTIC",
  };

  const res = await fetch(`${base}/pickup/v1/pickups`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-locale": "en_US",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as
    | { output?: { pickupConfirmationCode?: string; location?: string }; errors?: Array<{ message?: string }> }
    | null;
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message ?? `FedEx pickup failed (${res.status})`;
    throw new FedExError(msg, res.status, json);
  }
  const confirmationNumber = json?.output?.pickupConfirmationCode ?? "";
  if (!confirmationNumber) {
    throw new FedExError("FedEx pickup response missing confirmation code", res.status, json);
  }
  return { ok: true, confirmationNumber, location: json?.output?.location };
}
