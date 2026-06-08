// READ-ONLY verification that the deployed FedEx pickup config works — reports
// whether the env is complete and whether FedEx authorizes a pickup from the
// clinic address, WITHOUT scheduling one (no truck). Used to verify the Vercel
// env after setup. Auth mirrors the other worker debug routes.

import { NextResponse } from "next/server";
import { isPickupConfigured, checkPickupAvailability } from "@/lib/tracking/fedex-pickup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const configured = isPickupConfigured();
  // Surface which pickup-location vars are present (names only, never values).
  const present = {
    FEDEX_ACCOUNT_NUMBER: !!process.env.FEDEX_ACCOUNT_NUMBER,
    FEDEX_PICKUP_API_KEY: !!(process.env.FEDEX_PICKUP_API_KEY ?? process.env.FEDEX_API_KEY),
    FEDEX_PICKUP_CONTACT_NAME: !!process.env.FEDEX_PICKUP_CONTACT_NAME,
    FEDEX_PICKUP_CONTACT_PHONE: !!process.env.FEDEX_PICKUP_CONTACT_PHONE,
    FEDEX_PICKUP_STREET: !!process.env.FEDEX_PICKUP_STREET,
    FEDEX_PICKUP_STREET2: !!process.env.FEDEX_PICKUP_STREET2,
    FEDEX_PICKUP_CITY: !!process.env.FEDEX_PICKUP_CITY,
    FEDEX_PICKUP_STATE: !!process.env.FEDEX_PICKUP_STATE,
    FEDEX_PICKUP_ZIP: !!process.env.FEDEX_PICKUP_ZIP,
    FEDEX_PICKUP_CLOSE_TIME: process.env.FEDEX_PICKUP_CLOSE_TIME ?? "(default 16:30:00)",
    FEDEX_PICKUP_INSTRUCTIONS: !!process.env.FEDEX_PICKUP_INSTRUCTIONS,
  };

  if (!configured) {
    return NextResponse.json({ ok: false, configured: false, present });
  }
  try {
    const avail = await checkPickupAvailability({});
    const opt = (avail.body as { output?: { options?: Array<{ available?: boolean; cutOffTime?: string }> } })?.output?.options?.[0];
    return NextResponse.json({
      ok: avail.ok,
      configured: true,
      present,
      availability: { status: avail.status, available: opt?.available ?? null, cutOff: opt?.cutOffTime ?? null },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, configured: true, present, error: e instanceof Error ? e.message : String(e) });
  }
}
