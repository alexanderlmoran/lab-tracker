// Mint a signed Supabase Storage upload URL for the worker. The worker PUTs the
// scraped PDF straight to storage (bypassing this app's body limits), then calls
// /api/worker/result-ready with the storagePath — never the bytes. See
// src/lib/labs/pdf-upload.ts for why (large reports exceeded Vercel's body cap).
//
// Auth: Bearer ${WORKER_SHARED_SECRET}.

import { NextResponse } from "next/server";
import { z } from "zod";
import { mintPdfUploadUrl } from "@/lib/labs/pdf-upload";

export const dynamic = "force-dynamic";

const Body = z.object({
  caseId: z.string().uuid(),
  filename: z.string().min(1),
});

export async function POST(request: Request) {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `bad body: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  try {
    const { uploadUrl, storagePath } = await mintPdfUploadUrl(parsed.caseId, parsed.filename);
    return NextResponse.json({ ok: true, uploadUrl, storagePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ ok: false, error: msg }, { status: msg === "case not found" ? 404 : 500 });
  }
}
