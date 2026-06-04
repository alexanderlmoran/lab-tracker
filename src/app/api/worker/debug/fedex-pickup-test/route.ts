// Test trigger for the FedEx pickup integration. Bearer WORKER_SHARED_SECRET
// (so only Alex / the worker can call it). It books a REAL pickup — Alex will
// cancel it in the FedEx portal. Runs server-side on Vercel where the
// FEDEX_PICKUP_* creds live, so it exercises the exact production request.

import { NextResponse } from "next/server";
import { isPickupConfigured, schedulePickup } from "@/lib/tracking/fedex-pickup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isPickupConfigured()) {
    // Diagnostic: which env vars does THIS deployment's runtime actually see?
    // Booleans only — never echoes the values.
    const seen = {
      ACCOUNT_NUMBER: !!process.env.FEDEX_ACCOUNT_NUMBER,
      PICKUP_API_KEY: !!process.env.FEDEX_PICKUP_API_KEY,
      PICKUP_API_SECRET: !!process.env.FEDEX_PICKUP_API_SECRET,
      tracking_API_KEY_fallback: !!process.env.FEDEX_API_KEY,
      CONTACT_NAME: !!process.env.FEDEX_PICKUP_CONTACT_NAME,
      CONTACT_PHONE: !!process.env.FEDEX_PICKUP_CONTACT_PHONE,
      STREET: !!process.env.FEDEX_PICKUP_STREET,
      CITY: !!process.env.FEDEX_PICKUP_CITY,
      STATE: !!process.env.FEDEX_PICKUP_STATE,
      ZIP: !!process.env.FEDEX_PICKUP_ZIP,
    };
    return NextResponse.json(
      { ok: false, error: "FedEx pickup not configured — runtime env presence below", seen },
      { status: 412 },
    );
  }

  const url = new URL(request.url);
  const date =
    url.searchParams.get("date") ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow
  const count = Math.max(1, Number(url.searchParams.get("count") ?? "1"));

  try {
    const r = await schedulePickup({
      readyDate: date,
      packageCount: count,
      remarks: "TEST pickup — please cancel in the FedEx portal",
    });
    return NextResponse.json({
      ok: true,
      date,
      confirmationNumber: r.confirmationNumber,
      location: r.location,
    });
  } catch (err) {
    // Surface the raw FedEx error so we can fix the request shape if needed.
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
