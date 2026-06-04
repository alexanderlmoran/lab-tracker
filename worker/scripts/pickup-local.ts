// Self-contained LOCAL FedEx pickup test — proves the Create Pickup call works
// without depending on the (currently flaky) Vercel env. Config is baked in
// (Alex's account + Brickell address); reads ONLY the two pickup API secrets
// from env so they never live in the repo.
//
// Add to worker/.env.local (the two lines only you have):
//   FEDEX_PICKUP_API_KEY=...
//   FEDEX_PICKUP_API_SECRET=...
// then:  cd worker && npx tsx scripts/pickup-local.ts            (ready tomorrow)
//        cd worker && npx tsx scripts/pickup-local.ts 2026-06-08 (specific date)

import { request } from "undici";
import { gunzipSync } from "node:zlib";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();

const KEY = process.env.FEDEX_PICKUP_API_KEY;
const SECRET = process.env.FEDEX_PICKUP_API_SECRET;
const BASE = process.env.FEDEX_PICKUP_API_BASE ?? process.env.FEDEX_API_BASE ?? "https://apis.fedex.com";
if (!KEY || !SECRET) {
  throw new Error("Add FEDEX_PICKUP_API_KEY and FEDEX_PICKUP_API_SECRET to worker/.env.local");
}

const ACCOUNT = process.env.FX_ACCOUNT ?? "20847088";
const PICKUP = {
  contactName: "Centner Wellness",
  contactPhone: "3056025260",
  street: "2333 Brickell Ave Suite A-1",
  city: "Miami",
  state: "FL",
  zip: "33129",
  country: "US",
  readyTime: "14:30:00",
  closeTime: "16:30:00",
};

async function token(): Promise<string> {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: KEY!, client_secret: SECRET! });
  const r = await request(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = (await r.body.json().catch(() => ({}))) as { access_token?: string; errors?: unknown };
  if (r.statusCode !== 200 || !j.access_token) {
    throw new Error(`OAuth ${r.statusCode}: ${JSON.stringify(j)}`);
  }
  return j.access_token;
}

async function main() {
  const date = process.argv[2] ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tok = await token();
  console.log("OAuth OK. Booking pickup for", date, "…");

  const reqBody = {
    associatedAccountNumber: { key: "", value: ACCOUNT },
    originDetail: {
      pickupLocation: {
        contact: {
          personName: PICKUP.contactName,
          companyName: PICKUP.contactName,
          phoneNumber: PICKUP.contactPhone,
        },
        address: {
          streetLines: [PICKUP.street],
          city: PICKUP.city,
          stateOrProvinceCode: PICKUP.state,
          postalCode: PICKUP.zip,
          countryCode: PICKUP.country,
          residential: false,
        },
      },
      // Local ready time WITH the Miami offset (EDT, -04:00) — a bare timestamp
      // or a "Z" suffix would book the wrong hour.
      readyDateTimestamp: `${date}T${PICKUP.readyTime}-04:00`,
      customerCloseTime: PICKUP.closeTime,
      earlyPickup: false,
    },
    totalWeight: { units: "LB", value: 1 },
    carrierCode: "FDXE",
    remarks: "TEST pickup — cancel in portal",
    countryRelationship: "DOMESTIC",
  };

  const r = await request(`${BASE}/pickup/v1/pickups`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
      "x-locale": "en_US",
      "accept-encoding": "identity",
    },
    body: JSON.stringify(reqBody),
  });
  const buf = Buffer.from(await r.body.arrayBuffer());
  const text =
    r.headers["content-encoding"] === "gzip" ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  console.log("HTTP", r.statusCode);
  console.log("RESPONSE:", text || "<empty body>");
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
