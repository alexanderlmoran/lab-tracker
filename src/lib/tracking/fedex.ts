// FedEx Track API adapter. OAuth2 client_credentials flow + POST to
// /track/v1/trackingnumbers. Returns one normalized snapshot per tracking
// number; the action layer is responsible for persisting to lab_cases.
//
// Env vars (all required for the adapter to function — getFedExClient
// throws otherwise):
//
//   FEDEX_API_KEY        — client ID from FedEx Developer Portal
//   FEDEX_API_SECRET     — client secret
//   FEDEX_API_BASE       — "https://apis-sandbox.fedex.com" (test) or
//                          "https://apis.fedex.com" (prod)
//
// Token caching is in-process (module-level), good for the dev server and
// for Vercel function invocations within the same warm container. Tokens
// are 1h TTL; we treat them as 50min to avoid edge expiry.

import type { TrackingStatus } from "@/lib/types";

export type FedExTrackResult = {
  trackingNumber: string;
  status: TrackingStatus;
  /** Carrier verbatim text — e.g., "Picked up" / "On FedEx vehicle". */
  statusDetail: string | null;
  /** When the most-recent event happened, per FedEx. */
  eventAtIso: string | null;
  /** Free-text location, e.g., "Memphis, TN". */
  location: string | null;
  /** Set when status === "delivered". */
  deliveredAtIso: string | null;
  /** Raw FedEx body for one tracking number, kept for debugging only. */
  raw: unknown;
};

export class FedExError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "FedExError";
  }
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

function readEnv(): { key: string; secret: string; base: string } {
  const key = process.env.FEDEX_API_KEY;
  const secret = process.env.FEDEX_API_SECRET;
  const base = process.env.FEDEX_API_BASE;
  if (!key || !secret || !base) {
    throw new FedExError(
      "FedEx env not configured — set FEDEX_API_KEY, FEDEX_API_SECRET, FEDEX_API_BASE",
    );
  }
  return { key, secret, base };
}

/** FedEx API base URL (sandbox/prod), reused by the pickup client. */
export function fedexApiBase(): string {
  return readEnv().base;
}

/** OAuth token getter — shared by tracking and the pickup client so both reuse
 * the same cached client-credentials token. */
export async function getFedExAccessToken(): Promise<string> {
  return getAccessToken();
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const { key, secret, base } = readEnv();

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: key,
    client_secret: secret,
  });
  const r = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new FedExError(`OAuth failed (${r.status})`, r.status, text);
  }
  const json = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new FedExError("OAuth response missing access_token", 200, json);
  }
  const ttlSeconds = typeof json.expires_in === "number" ? json.expires_in : 3000;
  cachedToken = {
    token: json.access_token,
    // Use 50min upper bound regardless of stated TTL (defensive).
    expiresAtMs: Date.now() + Math.min(ttlSeconds, 3000) * 1000,
  };
  return cachedToken.token;
}

/**
 * Map FedEx's status codes / strings to our normalized enum. FedEx returns
 * a `code` (e.g. "DL", "IT", "OD", "PU") and a derivedStatus / description.
 * Both are useful: code is stable, description is human-readable.
 */
function normalizeStatus(code?: string, description?: string): TrackingStatus {
  const c = (code ?? "").toUpperCase();
  // Stable code-based mapping first. HP (Held at FedEx Pickup) and HL (Hold
  // at Location) both mean the package reached the destination hold point —
  // FedEx's website surfaces them as "Delivered" in the headline, so we
  // mirror that for parity with what staff sees on fedex.com.
  if (c === "DL" || c === "HP" || c === "HL" || c === "DV") return "delivered";
  if (c === "OD" || c === "DS") return "out_for_delivery";
  // PU (Picked Up) counts as in_transit: the package is in FedEx's hands, so
  // pickup-pending views clear and refresh-core's in_transit advance applies.
  if (c === "IT" || c === "AR" || c === "DP" || c === "AF" || c === "AP" || c === "PU")
    return "in_transit";
  if (c === "OC") return "pre_transit";
  if (c === "DE" || c === "SE" || c === "CA" || c === "DD") return "exception";
  if (c === "RS") return "returned";

  // Fallback to description text when code is unfamiliar.
  const d = (description ?? "").toLowerCase();
  if (!d) return "unknown";
  if (
    d.includes("delivered") ||
    d.includes("ready for pickup") ||
    d.includes("held at") ||
    d.includes("hold at")
  )
    return "delivered";
  if (d.includes("out for delivery")) return "out_for_delivery";
  if (
    d.includes("in transit") ||
    d.includes("on fedex vehicle") ||
    d.includes("departed") ||
    d.includes("arrived") ||
    d.includes("picked up")
  )
    return "in_transit";
  if (d.includes("label created") || d.includes("shipment information sent"))
    return "pre_transit";
  if (d.includes("exception") || d.includes("delay")) return "exception";
  if (d.includes("return")) return "returned";
  return "unknown";
}

type FedExScanEvent = {
  date?: string;
  eventType?: string;
  eventDescription?: string;
  scanLocation?: { city?: string; stateOrProvinceCode?: string; countryCode?: string };
};

type FedExTrackResults = {
  latestStatusDetail?: {
    code?: string;
    statusByLocale?: string;
    description?: string;
    scanLocation?: { city?: string; stateOrProvinceCode?: string };
  };
  scanEvents?: FedExScanEvent[];
  dateAndTimes?: Array<{ type?: string; dateTime?: string }>;
  deliveryDetails?: { actualDeliveryAddress?: { city?: string; stateOrProvinceCode?: string } };
};

type FedExCompleteResult = {
  trackingNumber?: string;
  trackResults?: FedExTrackResults[];
};

type FedExResponseBody = {
  output?: { completeTrackResults?: FedExCompleteResult[] };
  errors?: Array<{ code?: string; message?: string }>;
};

function fmtLocation(
  loc: { city?: string; stateOrProvinceCode?: string } | undefined,
): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.stateOrProvinceCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function pickDeliveredAt(
  status: TrackingStatus,
  dateAndTimes: FedExTrackResults["dateAndTimes"],
  latestEventDateIso: string | null,
): string | null {
  if (status !== "delivered") return null;
  // ACTUAL_DELIVERY is canonical for code DL, but absent for held-at-pickup
  // (HP) where the latest scan event itself is the "delivered" moment.
  const d = (dateAndTimes ?? []).find(
    (dt) => (dt.type ?? "").toUpperCase() === "ACTUAL_DELIVERY",
  );
  return d?.dateTime ?? latestEventDateIso;
}

/**
 * Track up to 30 FedEx tracking numbers in one API call. Returns one result
 * per input tracking number (preserving order). Tracking numbers FedEx
 * doesn't recognize get a status of "unknown" rather than throwing — the
 * caller can decide whether to skip or surface the lookup miss.
 */
export async function fedexTrackBatch(
  trackingNumbers: string[],
): Promise<FedExTrackResult[]> {
  if (trackingNumbers.length === 0) return [];
  if (trackingNumbers.length > 30) {
    throw new FedExError("FedEx Track API supports max 30 tracking numbers per call");
  }
  const { base } = readEnv();
  const token = await getAccessToken();

  const r = await fetch(`${base}/track/v1/trackingnumbers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-locale": "en_US",
    },
    body: JSON.stringify({
      trackingInfo: trackingNumbers.map((n) => ({
        trackingNumberInfo: { trackingNumber: n },
      })),
      includeDetailedScans: false,
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new FedExError(`Track API failed (${r.status})`, r.status, text);
  }

  const body = (await r.json()) as FedExResponseBody;
  const completeResults = body.output?.completeTrackResults ?? [];

  // Map back to inputs by tracking number — FedEx returns results in input
  // order but we re-key to be defensive.
  const byNumber = new Map<string, FedExTrackResults>();
  for (const cr of completeResults) {
    const tn = cr.trackingNumber;
    const tr = cr.trackResults?.[0];
    if (tn && tr) byNumber.set(tn, tr);
  }

  return trackingNumbers.map((tn): FedExTrackResult => {
    const tr = byNumber.get(tn);
    if (!tr) {
      return {
        trackingNumber: tn,
        status: "unknown",
        statusDetail: null,
        eventAtIso: null,
        location: null,
        deliveredAtIso: null,
        raw: null,
      };
    }
    const status = normalizeStatus(
      tr.latestStatusDetail?.code,
      tr.latestStatusDetail?.statusByLocale ?? tr.latestStatusDetail?.description,
    );
    const latestEvent = tr.scanEvents?.[0];
    const eventAtIso = latestEvent?.date ?? null;
    const location =
      fmtLocation(latestEvent?.scanLocation) ??
      fmtLocation(tr.latestStatusDetail?.scanLocation) ??
      fmtLocation(tr.deliveryDetails?.actualDeliveryAddress) ??
      null;
    const deliveredAtIso = pickDeliveredAt(status, tr.dateAndTimes, eventAtIso);
    return {
      trackingNumber: tn,
      status,
      statusDetail:
        tr.latestStatusDetail?.statusByLocale ??
        tr.latestStatusDetail?.description ??
        null,
      eventAtIso,
      location,
      deliveredAtIso,
      raw: tr,
    };
  });
}

export function isFedExConfigured(): boolean {
  return Boolean(
    process.env.FEDEX_API_KEY &&
      process.env.FEDEX_API_SECRET &&
      process.env.FEDEX_API_BASE,
  );
}
