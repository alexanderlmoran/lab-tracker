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

import { FedExError } from "./fedex";

// Pickup uses its OWN FedEx Developer credentials — the Pickup product is
// separate from Tracking, so Alex created a dedicated key. Falls back to the
// tracking key only if a pickup-specific one isn't set.
function pickupApiCreds(): { key: string; secret: string; base: string } | null {
  const key = process.env.FEDEX_PICKUP_API_KEY ?? process.env.FEDEX_API_KEY;
  const secret = process.env.FEDEX_PICKUP_API_SECRET ?? process.env.FEDEX_API_SECRET;
  const base =
    process.env.FEDEX_PICKUP_API_BASE ?? process.env.FEDEX_API_BASE ?? "https://apis.fedex.com";
  if (!key || !secret) return null;
  return { key, secret, base };
}

let cachedPickupToken: { token: string; expiresAtMs: number } | null = null;

async function getPickupToken(): Promise<{ token: string; base: string }> {
  const creds = pickupApiCreds();
  if (!creds) throw new FedExError("FedEx pickup API creds not set (FEDEX_PICKUP_API_KEY/SECRET).");
  if (cachedPickupToken && cachedPickupToken.expiresAtMs > Date.now() + 30_000) {
    return { token: cachedPickupToken.token, base: creds.base };
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.key,
    client_secret: creds.secret,
  });
  const r = await fetch(`${creds.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new FedExError(`FedEx pickup OAuth failed (${r.status})`, r.status, text);
  }
  const json = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new FedExError("FedEx pickup OAuth missing access_token", 200, json);
  cachedPickupToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.min(json.expires_in ?? 3000, 3000) * 1000,
  };
  return { token: cachedPickupToken.token, base: creds.base };
}

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

/** True when the pickup API creds AND the pickup-location env are configured. */
export function isPickupConfigured(): boolean {
  return pickupApiCreds() != null && !("missing" in readPickupConfig());
}

/**
 * READ-ONLY pickup-availability check. Confirms whether FedEx will authorize a
 * pickup from the clinic address WITHOUT scheduling one (no truck). Use this to
 * test credential/account authorization safely: a 200 means the project+account
 * are pickup-authorized (so schedulePickup should work); a 403 FORBIDDEN /
 * USER.UNAUTHORIZED means the FedEx project isn't approved for the Pickup
 * product — a developer-portal gate, not a code bug.
 * Note: availabilities uses SINGULAR `countryRelationship` (create uses plural).
 */
export async function checkPickupAvailability(opts: { readyDate?: string } = {}): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const cfg = readPickupConfig();
  if ("missing" in cfg) {
    throw new FedExError(`FedEx pickup not configured — set: ${cfg.missing.join(", ")}`);
  }
  const { token, base } = await getPickupToken();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const readyDate = opts.readyDate ?? today;
  const body = {
    pickupAddress: { postalCode: cfg.zip, countryCode: cfg.country },
    pickupRequestType: [readyDate <= today ? "SAME_DAY" : "FUTURE_DAY"],
    carriers: ["FDXE"],
    countryRelationship: "DOMESTIC",
  };
  const res = await fetch(`${base}/pickup/v1/pickups/availabilities`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-locale": "en_US" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body: json };
}

export async function schedulePickup(input: SchedulePickupInput): Promise<SchedulePickupResult> {
  const cfg = readPickupConfig();
  if ("missing" in cfg) {
    throw new FedExError(`FedEx pickup not configured — set: ${cfg.missing.join(", ")}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.readyDate)) {
    throw new FedExError("readyDate must be YYYY-MM-DD");
  }

  const { token, base } = await getPickupToken();

  // Body shape corrected 2026-06-08 against the official Pickup Request API
  // Postman collection (Alex supplied it): `associatedAccountNumber` is `{value}`
  // with NO `key` (an empty key breaks account auth → USER.UNAUTHORIZED);
  // `countryRelationships` is PLURAL; `pickupDateType` is required; the canonical
  // body also carries `pickupAddressType`, `packageLocation`, and top-level
  // `packageCount`. NOTE: if this still returns FORBIDDEN/USER.UNAUTHORIZED the
  // FedEx project simply isn't authorized for the Pickup product — a portal gate,
  // not a body problem (see TASKS.md). Use checkPickupAvailability() to test that
  // safely (read-only, no truck dispatched).
  const readyTime = input.readyTime ?? process.env.FEDEX_PICKUP_READY_TIME ?? "14:30:00";
  const tzOffset = process.env.FEDEX_PICKUP_UTC_OFFSET ?? "-04:00"; // Miami EDT; -05:00 in winter
  // pickupDateType is required: SAME_DAY when ready today (clinic tz), else FUTURE_DAY.
  const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const pickupDateType = input.readyDate <= todayLocal ? "SAME_DAY" : "FUTURE_DAY";
  const body = {
    associatedAccountNumber: { value: cfg.account },
    originDetail: {
      pickupAddressType: "OTHER",
      pickupLocation: {
        contact: {
          personName: cfg.contactName,
          companyName: cfg.contactName,
          phoneNumber: cfg.contactPhone,
        },
        address: {
          streetLines: [cfg.street],
          city: cfg.city,
          stateOrProvinceCode: cfg.state,
          postalCode: cfg.zip,
          countryCode: cfg.country,
          residential: false,
        },
      },
      // Alex's preference: ready 2:30pm, clinic close (customerCloseTime) 4:30pm.
      readyDateTimestamp: `${input.readyDate}T${readyTime}${tzOffset}`,
      customerCloseTime: cfg.closeTime,
      pickupDateType,
      packageLocation: process.env.FEDEX_PICKUP_PACKAGE_LOCATION ?? "FRONT",
    },
    totalWeight: { units: "LB", value: Math.max(1, input.packageCount ?? 1) },
    packageCount: input.packageCount ?? 1,
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
