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
  /** Optional second address line, e.g. "Suite A-1". */
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  closeTime: string;
  /** Optional driver instructions at the pickup location, e.g. "Downstairs, Reception". */
  instructions?: string;
};

function readPickupConfig(): PickupConfig | { missing: string[] } {
  const fields: Array<[keyof PickupConfig, string | undefined, boolean]> = [
    ["account", process.env.FEDEX_ACCOUNT_NUMBER, true],
    ["contactName", process.env.FEDEX_PICKUP_CONTACT_NAME, true],
    ["contactPhone", process.env.FEDEX_PICKUP_CONTACT_PHONE, true],
    ["street", process.env.FEDEX_PICKUP_STREET, true],
    ["street2", process.env.FEDEX_PICKUP_STREET2, false],
    ["city", process.env.FEDEX_PICKUP_CITY, true],
    ["state", process.env.FEDEX_PICKUP_STATE, true],
    ["zip", process.env.FEDEX_PICKUP_ZIP, true],
    ["country", process.env.FEDEX_PICKUP_COUNTRY ?? "US", false],
    // Default close 16:30 (4:30pm): Alex's preference so a late FedEx still
    // leaves time to drive samples to a local FedEx before the clinic's 7pm close.
    ["closeTime", process.env.FEDEX_PICKUP_CLOSE_TIME ?? "16:30:00", false],
    ["instructions", process.env.FEDEX_PICKUP_INSTRUCTIONS, false],
  ];
  const missing = fields.filter(([, v, required]) => required && !v).map(([k]) => k);
  if (missing.length) return { missing };
  const cfg = Object.fromEntries(
    fields.filter(([, v]) => v !== undefined).map(([k, v]) => [k, v]),
  ) as unknown as PickupConfig;
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

/** Clinic-local clock time "HH:MM:SS" (24h) right now. */
function clinicTimeNow(): string {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
}

/** Minutes since midnight for an "HH:MM[:SS]" string. */
function timeToMinutes(hms: string): number {
  const [h = 0, m = 0] = hms.split(":").map(Number);
  return h * 60 + m;
}

/** hms + addMinutes, rounded up to the next 5-minute mark → "HH:MM:00". */
function roundUpToFiveMinutes(hms: string, addMinutes: number): string {
  const total = Math.ceil((timeToMinutes(hms) + addMinutes) / 5) * 5;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
}

/** The clinic's current UTC offset ("-04:00" EDT / "-05:00" EST), from the tz
 * database — so the winter flip no longer needs an env change.
 * FEDEX_PICKUP_UTC_OFFSET still wins when set. */
function clinicUtcOffset(): string {
  const env = process.env.FEDEX_PICKUP_UTC_OFFSET;
  if (env) return env;
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return part?.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? "-04:00";
}

/** Inverse of timeToMinutes → "HH:MM:00" (clamped to the same day). */
function minutesToHms(total: number): string {
  const t = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
}

/** Pull an "HH:MM" / "HH:MM:SS" out of a FedEx field (which may be a bare time
 *  or a full ISO timestamp), normalized to "HH:MM:SS". */
function extractHms(v: unknown): string | null {
  const m = String(v ?? "").match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : null;
}

type PickupWindow = {
  available: boolean;
  /** Minutes FedEx needs between the ready time and close (lead time). */
  accessMinutes: number;
  /** Latest local time a same-day request is still accepted ("HH:MM:SS"). */
  cutOffTime: string | null;
  /** Latest local time the truck will arrive — use as customerCloseTime. */
  latestTime: string | null;
};

/**
 * Ask FedEx what pickup window is actually available for the clinic address on a
 * given date (read-only — no truck). The old code guessed a fixed 2:30pm ready /
 * 4:30pm close, which FedEx rejects with "Package is not accessible for the
 * request time" whenever the requested ready time lands after the area's
 * same-day cutoff. Returns null (→ caller falls back to env defaults, no
 * regression) when availabilities is unreachable or unparseable.
 */
async function fetchPickupWindow(opts: {
  readyDate: string;
  carrier: "FDXE" | "FDXG";
  schedule: "SAME_DAY" | "FUTURE_DAY";
}): Promise<PickupWindow | null> {
  const cfg = readPickupConfig();
  if ("missing" in cfg) return null;
  let token: string;
  let base: string;
  try {
    ({ token, base } = await getPickupToken());
  } catch {
    return null;
  }
  const body = {
    pickupAddress: { postalCode: cfg.zip, countryCode: cfg.country },
    pickupRequestType: [opts.schedule],
    carriers: [opts.carrier],
    countryRelationship: "DOMESTIC",
  };
  let json: { output?: { options?: Array<Record<string, unknown>> } } | null = null;
  try {
    const res = await fetch(`${base}/pickup/v1/pickups/availabilities`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-locale": "en_US" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    json = await res.json().catch(() => null);
  } catch {
    return null;
  }
  const options = json?.output?.options ?? [];
  if (!options.length) return null;
  const want = opts.schedule.replace(/[^A-Z]/g, "");
  const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  // FedEx echoes carrier + schedule on each option; match ours, else take the
  // first available, else the first option.
  const match =
    options.find((o) => norm(o.carrier) === opts.carrier && norm(o.scheduleDay ?? o.schedule) === want) ??
    options.find((o) => o.available !== false) ??
    options[0];
  // accessTime is FedEx's required lead window between the ready time and close,
  // formatted "HH:MM:SS" as a DURATION (e.g. "02:00:00" = 120 min). Guard the
  // parse: anything implausible as a lead time (≤0 or >4h — including a
  // clock-of-day value FedEx might send instead) falls back to a safe 60-min
  // default rather than computing an absurd ready window.
  const accessRaw = extractHms(match.accessTime);
  const accessParsed = accessRaw ? timeToMinutes(accessRaw) : 60;
  return {
    available: match.available !== false,
    accessMinutes: accessParsed > 0 && accessParsed <= 240 ? accessParsed : 60,
    cutOffTime: extractHms(match.cutOffTime),
    latestTime: extractHms(match.latestTimeForPickup ?? match.latestPickupDateTime ?? match.businessCloseTime),
  };
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
  let readyTime = input.readyTime ?? process.env.FEDEX_PICKUP_READY_TIME ?? "14:30:00";
  const tzOffset = clinicUtcOffset();
  // pickupDateType is required: SAME_DAY when ready today (clinic tz), else FUTURE_DAY.
  const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (input.readyDate < todayLocal) {
    throw new FedExError(`Ready date ${input.readyDate} already passed — pick today or later.`);
  }
  const pickupDateType = input.readyDate === todayLocal ? "SAME_DAY" : "FUTURE_DAY";

  // Ask FedEx for the REAL pickup window for this address+date instead of
  // guessing. The old fixed 2:30pm-ready / 4:30pm-close pair triggered "Package
  // is not accessible for the request time" whenever the ready time fell after
  // the area's same-day cutoff — Alex had to fall back to picking 12:30–16:30 by
  // hand on fedex.com. We fit the ready time into FedEx's window and widen the
  // close to FedEx's latest pickup time. A null window keeps the env defaults
  // (no regression when availabilities is unreachable).
  const win = await fetchPickupWindow({
    readyDate: input.readyDate,
    carrier: input.carrierCode ?? "FDXE",
    schedule: pickupDateType,
  });
  let closeTime = cfg.closeTime;
  const accessMin = win?.accessMinutes ?? 60;
  if (win) {
    if (!win.available) {
      throw new FedExError(
        pickupDateType === "SAME_DAY"
          ? "FedEx has no same-day pickup available for the clinic today — schedule the next business day, or drop the package at a FedEx location."
          : `FedEx has no pickup available on ${input.readyDate} — choose another business day.`,
      );
    }
    // Adopt FedEx's latest pickup time as the close when it's later than ours —
    // the wider window FedEx actually accepts.
    if (win.latestTime && timeToMinutes(win.latestTime) > timeToMinutes(closeTime)) {
      closeTime = win.latestTime;
    }
  }

  // Latest ready time that still leaves FedEx's required lead window before close
  // (and, same-day, is no later than the request cutoff).
  let latestReady = timeToMinutes(closeTime) - accessMin;
  if (pickupDateType === "SAME_DAY" && win?.cutOffTime) {
    latestReady = Math.min(latestReady, timeToMinutes(win.cutOffTime));
  }
  if (pickupDateType === "SAME_DAY") {
    // Ready can't be in the past — clamp to ~20 min from now.
    const earliestReady = timeToMinutes(roundUpToFiveMinutes(clinicTimeNow(), 20));
    if (timeToMinutes(readyTime) < earliestReady) readyTime = minutesToHms(earliestReady);
    if (earliestReady > latestReady) {
      throw new FedExError(
        `Too late for a same-day pickup — FedEx needs the package ready by ` +
          `${minutesToHms(latestReady).slice(0, 5)} (its cutoff / required ${accessMin}-min lead before ` +
          `${closeTime.slice(0, 5)} close), but the earliest we can mark it ready now is ` +
          `${minutesToHms(earliestReady).slice(0, 5)}. Schedule the next business day, or drop it at a FedEx location.`,
      );
    }
  }
  // A preferred ready time later than the window allows is pulled back to fit,
  // rather than letting FedEx reject the whole request.
  if (timeToMinutes(readyTime) > latestReady) readyTime = minutesToHms(latestReady);
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
          streetLines: [cfg.street, cfg.street2].filter(Boolean) as string[],
          city: cfg.city,
          stateOrProvinceCode: cfg.state,
          postalCode: cfg.zip,
          countryCode: cfg.country,
          residential: false,
        },
        // Driver instructions at the door (e.g. "Downstairs, Reception"); omitted
        // from the JSON when unset.
        ...(cfg.instructions ? { deliveryInstructions: cfg.instructions } : {}),
      },
      // Defaults: ready 2:30pm (clamped forward for late same-day bookings),
      // clinic close (customerCloseTime) 4:30pm.
      readyDateTimestamp: `${input.readyDate}T${readyTime}${tzOffset}`,
      customerCloseTime: closeTime,
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
