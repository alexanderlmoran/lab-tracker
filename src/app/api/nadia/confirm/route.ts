// Nadia clicks the link in the "all labs received" email to confirm she's
// reached out to the patient about scheduling. The token came from
// maybeFireNadiaAllReceived → stamped on every sibling case so one click
// marks the whole batch confirmed.
//
// This is an UNAUTHENTICATED route: Nadia opens email → clicks link. The
// token itself is the credential (uuid, only sent to her inbox). It is
// single-use in the sense that subsequent clicks are idempotent — they
// won't double-stamp, just show the same "Confirmed" page.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { LabCase } from "@/lib/types";

export const dynamic = "force-dynamic";

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f8fafc; color: #0b1f3a; margin: 0; padding: 0; }
      .card { max-width: 520px; margin: 48px auto; padding: 32px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
      h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; margin: 0 0 16px; }
      p { font-size: 15px; line-height: 1.6; margin: 0 0 12px; }
      ul { padding-left: 20px; }
      li { font-size: 14px; line-height: 1.5; }
      .muted { color: #6b7a8c; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">${body}</div>
  </body>
</html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    return new NextResponse(
      htmlPage(
        "Invalid link",
        `<h1>Invalid link</h1><p>This confirmation link is missing its token. Please use the link from the email.</p>`,
      ),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const db = getSupabaseAdmin();
  const { data: rows } = await db
    .from("lab_cases")
    .select("*")
    .eq("nadia_confirm_token", token);
  const cases = (rows ?? []) as LabCase[];

  if (cases.length === 0) {
    return new NextResponse(
      htmlPage(
        "Link not found",
        `<h1>Link not found</h1><p>This confirmation link is no longer valid. The token may have been replaced by a newer notification.</p>`,
      ),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const first = cases[0];
  const alreadyConfirmed = cases.every((c) => c.nadia_confirmed_at);
  const now = new Date().toISOString();

  if (!alreadyConfirmed) {
    await db
      .from("lab_cases")
      .update({ nadia_confirmed_at: now })
      .eq("nadia_confirm_token", token)
      .is("nadia_confirmed_at", null);

    await db.from("lab_events").insert(
      cases.map((c) => ({
        case_id: c.id,
        kind: "case_edited" as const,
        actor: "nadia (email link)",
        note: "Nadia confirmed scheduling outreach via email link",
        meta: { nadia_confirm_token: token },
      })),
    );
  }

  const labList = cases
    .map((c) => `<li>${c.lab_panel ? `${c.lab_name} ${c.lab_panel}` : c.lab_name}</li>`)
    .join("");

  const heading = alreadyConfirmed
    ? "Already confirmed"
    : "Outreach confirmed — thank you";

  const lead = alreadyConfirmed
    ? `This batch was already confirmed previously.`
    : `Thanks Nadia. Scheduling outreach for <strong>${first.patient_name}</strong> has been logged.`;

  return new NextResponse(
    htmlPage(
      heading,
      `<h1>${heading}</h1>
       <p>${lead}</p>
       <p>Labs in this batch:</p>
       <ul>${labList}</ul>
       <p class="muted">You can close this tab.</p>`,
    ),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
