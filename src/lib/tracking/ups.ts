// UPS Track API adapter — the UPS counterpart to fedex.ts. OAuth2
// client_credentials (Basic-auth token endpoint) + GET /api/track/v1/details/
// {trackingNumber} per number (UPS has no multi-number batch like FedEx). Returns
// the SAME normalized shape as the FedEx adapter (FedExTrackResult) so
// refresh-core treats both carriers uniformly.
//
// Env vars (all required):
//   UPS_CLIENT_ID      — client id from the UPS Developer portal
//   UPS_CLIENT_SECRET  — client secret
//   UPS_API_BASE       — "https://wwwcie.ups.com" (test/CIE) or
//                        "https://onlinetools.ups.com" (prod)

import type { TrackingStatus } from "@/lib/types";
import type { FedExTrackResult } from "./fedex";

/** UPS returns the same normalized snapshot shape as FedEx. */
export type UpsTrackResult = FedExTrackResult;

export class UpsError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = "UpsError";
  }
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

function readEnv(): { id: string; secret: string; base: string } {
  const id = process.env.UPS_CLIENT_ID;
  const secret = process.env.UPS_CLIENT_SECRET;
  const base = process.env.UPS_API_BASE;
  if (!id || !secret || !base) {
    throw new UpsError("UPS env not configured — set UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_API_BASE");
  }
  return { id, secret, base: base.replace(/\/+$/, "") };
}

export function isUpsConfigured(): boolean {
  return Boolean(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET && process.env.UPS_API_BASE);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 30_000) return cachedToken.token;
  const { id, secret, base } = readEnv();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(`${base}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new UpsError(`UPS OAuth failed (${r.status})`, r.status, text);
  }
  const json = (await r.json()) as { access_token?: string; expires_in?: string | number };
  if (!json.access_token) throw new UpsError("UPS OAuth response missing access_token", 200, json);
  const ttl = Number(json.expires_in ?? 3000);
  cachedToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.min(Number.isFinite(ttl) ? ttl : 3000, 3000) * 1000,
  };
  return cachedToken.token;
}

/** UPS activity status.type → our enum, with a description fallback (mirrors the
 *  FedEx mapping). UPS types: D delivered · I in-transit · P pickup · M/MV
 *  manifest/billing-received · X exception · RS returned. */
function normalizeStatus(type?: string, description?: string): TrackingStatus {
  const t = (type ?? "").toUpperCase();
  const d = (description ?? "").toLowerCase();
  if (t === "D") return "delivered";
  if (t === "RS") return "returned";
  if (t === "X") return d.includes("return") ? "returned" : "exception";
  if (t === "M" || t === "MV") return "pre_transit";
  if (t === "P") return "in_transit"; // picked up
  if (t === "I") return d.includes("out for delivery") ? "out_for_delivery" : "in_transit";
  // Unknown type → description text.
  if (!d) return "unknown";
  if (d.includes("delivered")) return "delivered";
  if (d.includes("out for delivery")) return "out_for_delivery";
  if (d.includes("return")) return "returned";
  if (d.includes("in transit") || d.includes("departed") || d.includes("arrived") || d.includes("picked up") || d.includes("origin scan") || d.includes("out for delivery"))
    return "in_transit";
  if (d.includes("order processed") || d.includes("label created") || d.includes("billing information") || d.includes("shipper created"))
    return "pre_transit";
  if (d.includes("exception") || d.includes("delay")) return "exception";
  return "unknown";
}

type UpsAddress = { city?: string; stateProvince?: string; stateProvinceCode?: string; countryCode?: string };
type UpsActivity = {
  status?: { type?: string; description?: string; code?: string };
  date?: string; // YYYYMMDD
  time?: string; // HHMMSS
  location?: { address?: UpsAddress };
};
type UpsPackage = {
  trackingNumber?: string;
  activity?: UpsActivity[];
  deliveryDate?: Array<{ type?: string; date?: string }>;
};
type UpsBody = {
  trackResponse?: { shipment?: Array<{ package?: UpsPackage[] }> };
  response?: { errors?: Array<{ code?: string; message?: string }> };
};

function fmtLocation(a: UpsAddress | undefined): string | null {
  if (!a) return null;
  const parts = [a.city, a.stateProvince ?? a.stateProvinceCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** UPS "YYYYMMDD" + "HHMMSS" → naive local ISO "YYYY-MM-DDTHH:MM:SS" (UPS gives
 *  no timezone). Null when the date is missing/malformed. */
function upsDateTime(date?: string, time?: string): string | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const t = time && /^\d{6}$/.test(time) ? `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}` : "T00:00:00";
  return `${d}${t}`;
}

async function trackOne(base: string, token: string, trackingNumber: string): Promise<UpsTrackResult> {
  const transId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, "").slice(0, 32);
  const r = await fetch(`${base}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      transId,
      transactionSrc: "centnerlabs",
    },
  });
  const unknown: UpsTrackResult = {
    trackingNumber,
    status: "unknown",
    statusDetail: null,
    eventAtIso: null,
    location: null,
    deliveredAtIso: null,
    raw: null,
  };
  if (r.status === 404) {
    await r.text().catch(() => {});
    return unknown; // UPS doesn't recognize it (yet) — treat like FedEx's unknown
  }
  if (!r.ok) {
    await r.text().catch(() => {});
    return unknown; // don't fail the whole batch on one bad number
  }
  const body = (await r.json()) as UpsBody;
  const pkg = body.trackResponse?.shipment?.[0]?.package?.[0];
  const activity = pkg?.activity?.[0];
  if (!activity) return unknown;
  const status = normalizeStatus(activity.status?.type, activity.status?.description);
  const eventAtIso = upsDateTime(activity.date, activity.time);
  const deliveredAtIso =
    status === "delivered"
      ? upsDateTime(pkg?.deliveryDate?.find((x) => (x.type ?? "").toUpperCase() === "DEL")?.date ?? activity.date, activity.time)
      : null;
  return {
    trackingNumber,
    status,
    statusDetail: activity.status?.description ?? null,
    eventAtIso,
    location: fmtLocation(activity.location?.address),
    deliveredAtIso,
    raw: pkg,
  };
}

/**
 * Track a set of UPS numbers. UPS is one-number-per-call, so this loops (with
 * light concurrency). A token/auth failure throws (caller counts the whole
 * group as errored); a per-number miss returns an "unknown" snapshot.
 */
export async function upsTrackBatch(trackingNumbers: string[]): Promise<UpsTrackResult[]> {
  if (trackingNumbers.length === 0) return [];
  const { base } = readEnv();
  const token = await getAccessToken();
  const out: UpsTrackResult[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < trackingNumbers.length; i += CONCURRENCY) {
    const slice = trackingNumbers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((n) => trackOne(base, token, n)));
    out.push(...results);
  }
  return out;
}
