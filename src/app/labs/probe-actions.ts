"use server";

import { revalidatePath } from "next/cache";
import { requireSignedIn } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import type { ActionResult } from "@/lib/types";

export type ProbeCandidate = {
  ref: string | null;
  pdfBytes: number;
  pdfFilename: string | null;
  resultIssuedAt: string | null;
  /** Set by name-search probes (e.g. Access): collection date + portal status,
   *  so staff can pick the right accession from a multi-result history. */
  collectionDate?: string | null;
  status?: string | null;
};

export type ProbeResult = {
  lab: string;
  labKey: string;
  name: string;
  found: ProbeCandidate[];
  errors: Array<{ caseId: string; message: string }>;
};

/**
 * Find a result for a case by PATIENT NAME, no accession needed. Proxies the
 * worker's POST /probe/:lab?name= so staff can proactively verify + clear
 * accession-less cards. Returns the candidate result(s) WITHOUT posting; an
 * empty `found` doubles as a "not ready in the portal yet" signal.
 */
export async function probeCaseResult(input: {
  caseId: string;
}): Promise<ActionResult<ProbeResult>> {
  await requireSignedIn();

  const db = getSupabaseAdmin();
  const { data: caseRow } = await db
    .from("lab_cases")
    .select("id, patient_name, patient_dob, lab_name")
    .eq("id", input.caseId)
    .maybeSingle();
  if (!caseRow) return { ok: false, error: "Case not found" };

  const labKey = probeKeyForLab(caseRow.lab_name as string);
  if (!labKey) {
    return {
      ok: false,
      error: `No scraper for lab "${caseRow.lab_name}" — can't find a result by name.`,
    };
  }

  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return { ok: false, error: "WORKER_SHARED_SECRET not configured" };
  const base = (process.env.WORKER_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");

  const params = new URLSearchParams({ name: String(caseRow.patient_name ?? "") });
  if (caseRow.patient_dob) params.set("dob", String(caseRow.patient_dob));
  const url = `${base}/probe/${encodeURIComponent(labKey)}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(180_000), // live portal scrape can be slow
    });
    const json = (await res.json().catch(() => null)) as
      | (ProbeResult & { error?: string })
      | { error?: string }
      | null;
    if (!res.ok) {
      const msg = json && "error" in json && json.error ? json.error : `worker returned ${res.status}`;
      return { ok: false, error: `worker: ${msg}` };
    }
    const data = (json ?? {}) as Partial<ProbeResult>;
    return {
      ok: true,
      data: {
        lab: data.lab ?? labKey,
        labKey,
        name: data.name ?? String(caseRow.patient_name ?? ""),
        found: data.found ?? [],
        errors: data.errors ?? [],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worker unreachable at ${base} — is it running? (${msg})` };
  }
}

/**
 * Write an accession (lab_external_ref) onto a case — the "clear the card"
 * follow-up after a name-probe surfaces the right result. Logs the change so
 * the activity log shows it came from the probe flow. Once set, the normal
 * deterministic scrape → PB-upload pipeline can take the case the rest of the
 * way.
 */
export async function setCaseAccession(input: {
  caseId: string;
  accession: string;
}): Promise<ActionResult> {
  const user = await requireSignedIn();
  const accession = input.accession.trim();
  if (!accession) return { ok: false, error: "Accession is required" };

  const db = getSupabaseAdmin();
  const { data: current } = await db
    .from("lab_cases")
    .select("lab_external_ref")
    .eq("id", input.caseId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Case not found" };

  const from = (current as { lab_external_ref: string | null }).lab_external_ref;
  if (from === accession) return { ok: true };

  const { error } = await db
    .from("lab_cases")
    .update({ lab_external_ref: accession })
    .eq("id", input.caseId);
  if (error) return { ok: false, error: error.message };

  await db.from("lab_events").insert({
    case_id: input.caseId,
    kind: "case_edited",
    actor: user.email ?? "admin",
    meta: { changes: { lab_external_ref: { from, to: accession } }, source: "name_probe" },
  });

  revalidatePath("/labs");
  revalidatePath(`/labs/${input.caseId}`);
  return { ok: true };
}
