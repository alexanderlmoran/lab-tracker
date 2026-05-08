import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { renderEmail } from "@/lib/email/render";
import type { EmailKind, LabCase } from "@/lib/types";

const Q = z.object({
  caseId: z.string().uuid(),
  kind: z.enum(["sample_sent", "partial_uploaded", "complete_uploaded", "rof_followup"]),
});

export async function GET(req: NextRequest) {
  await requireAdmin();
  const url = new URL(req.url);
  const parsed = Q.safeParse({
    caseId: url.searchParams.get("caseId"),
    kind: url.searchParams.get("kind"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  const db = getSupabaseAdmin();
  const { data } = await db
    .from("lab_cases")
    .select("*")
    .eq("id", parsed.data.caseId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rendered = await renderEmail(data as LabCase, parsed.data.kind as EmailKind);
  return new NextResponse(rendered.html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
