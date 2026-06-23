import { request } from "undici";

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;

if (!BASE) throw new Error("TRACKER_BASE_URL is required");
if (!SECRET) throw new Error("WORKER_SHARED_SECRET is required");

export type OpenCase = {
  caseId: string;
  patientName: string;
  patientDob: string | null;
  patientEmail: string;
  labName: string;
  labExternalRef: string | null;
  sampleSentAt: string | null;
  trackingDeliveredAt: string | null;
  expectedResultAtMin: string | null;
  expectedResultAtMax: string | null;
  /** Accessions previously rejected for this case (Disapprove / engine
   *  date-mismatch). The scraper skips these so it keeps searching for a
   *  newer result instead of re-offering the same wrong one. */
  dismissedRefs?: string[];
};

export async function fetchOpenCases(lab: string): Promise<OpenCase[]> {
  const res = await request(`${BASE}/api/worker/open-cases?lab=${encodeURIComponent(lab)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`open-cases failed ${res.statusCode}: ${body}`);
  }
  const json = (await res.body.json()) as { cases: OpenCase[] };
  return json.cases;
}

export type ResultReadyPayload = {
  caseId: string;
  labExternalRef: string;
  pdfBase64: string;
  pdfFilename: string;
  resultIssuedAt?: string;
  /** Lab-reported sample-collection date (YYYY-MM-DD). When set, result-ready
   * writes it onto the case so the PB "Date Ordered" reflects the real
   * collection, not the Zenoti booking or the scrape day. */
  collectionDate?: string | null;
  source: string;
  /** When true the tracker marks step 2 (partial received) instead of step 4
   * (complete) — so a drip lab (Vibrant/Access) can't auto-complete a case off
   * a partial report. The result-ready route already understands this flag. */
  isPartial?: boolean;
  /** Patient name as the portal shows it for the matched row. result-ready
   * rejects the stage (409) when the last name doesn't match the case. */
  portalPatientName?: string;
  /** Reconciliation engine: approve + enqueue the PB upload without a human
   * click (only set when the capture graded ≥ the auto-post threshold). */
  autoApprove?: boolean;
  /** Capture-confidence score (0-100), recorded for audit/flag context. */
  confidence?: number;
};

/** Ask the app to mint a signed Storage upload URL (the worker never holds
 *  Storage credentials — the app gates it behind WORKER_SHARED_SECRET). */
async function getResultUploadUrl(
  caseId: string,
  filename: string,
): Promise<{ uploadUrl: string; storagePath: string }> {
  const res = await request(`${BASE}/api/worker/result-upload-url`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ caseId, filename }),
  });
  const body = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`result-upload-url failed ${res.statusCode}: ${body}`);
  return JSON.parse(body) as { uploadUrl: string; storagePath: string };
}

export async function postResultReady(payload: ResultReadyPayload): Promise<void> {
  // Direct-to-storage: PUT the bytes STRAIGHT to Supabase Storage (no body cap),
  // then post the metadata by storagePath — never the base64 through the app. A
  // 4 MB+ report (~5.6 MB base64) used to exceed Vercel's request-body cap on
  // /api/worker/result-ready, so the worker fetched it but couldn't hand it over
  // and the result silently never staged. This makes any size post.
  const pdfBytes = Buffer.from(payload.pdfBase64, "base64");
  const { uploadUrl, storagePath } = await getResultUploadUrl(payload.caseId, payload.pdfFilename);
  const put = await request(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/pdf", "x-upsert": "false" },
    body: pdfBytes,
  });
  if (put.statusCode !== 200) {
    throw new Error(`storage PUT failed ${put.statusCode}: ${(await put.body.text()).slice(0, 200)}`);
  }

  const rest: Record<string, unknown> = { ...payload };
  delete rest.pdfBase64; // sent to Storage above, not through the app
  const res = await request(`${BASE}/api/worker/result-ready`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...rest, storagePath, sizeBytes: pdfBytes.length }),
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`result-ready failed ${res.statusCode}: ${body}`);
  }
}

export type EngineRunPayload = {
  lab?: string;
  mode?: "apply" | "dry";
  advanced: number;
  autoposted: number;
  flagged: number;
  searching: number;
  errors: number;
};

/** Record one reconcile cycle's tally for the Analytics Engine tab. Metrics are
 *  best-effort: a failed write must never break the cycle, so we swallow + warn. */
export async function postEngineRun(payload: EngineRunPayload): Promise<void> {
  try {
    const res = await request(`${BASE}/api/worker/engine-run`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.statusCode !== 200) console.warn(`[metrics] engine-run ${res.statusCode}: ${(await res.body.text()).slice(0, 120)}`);
    else await res.body.text();
  } catch (e) {
    console.warn(`[metrics] engine-run post failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** One patient's identity points pulled from the Zenoti guest profile, on their
 *  way into the tracker's patients_seed cache ("1 feeds the rest"). email is the
 *  upsert key — rows without it are skipped (patients_seed.email is NOT NULL). */
export type PatientEnrichRecord = {
  name: string;
  email: string;
  phone: string | null;
  /** YYYY-MM-DD. */
  dob: string | null;
  /** "M" / "F". */
  sex: string | null;
  /** "street, city, ST zip". */
  address: string | null;
};

/** Upsert Zenoti-sourced patient profiles into patients_seed. Returns the
 *  server's upserted/skipped tally. Throws on non-200 (unlike the best-effort
 *  metrics posts) so the enrich script surfaces a real failure. */
export async function postPatientEnrich(
  patients: PatientEnrichRecord[],
): Promise<{ upserted: number; skipped: number }> {
  const res = await request(`${BASE}/api/worker/patient-enrich`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ patients }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`patient-enrich failed ${res.statusCode}: ${(await res.body.text()).slice(0, 200)}`);
  }
  return (await res.body.json()) as { upserted: number; skipped: number };
}

export type RosterLabRequest = {
  name: string;
  dateOrdered: string | null;
  clientId: string | null;
  firstName: string | null;
  lastName: string | null;
};

/** Ship the PB labrequest roster so the tracker can compute a coverage snapshot
 *  (it owns the case data). Best-effort, like postEngineRun. */
export async function postCoverageSnapshot(labrequests: RosterLabRequest[]): Promise<void> {
  try {
    const res = await request(`${BASE}/api/worker/coverage-snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ labrequests }),
    });
    if (res.statusCode !== 200) console.warn(`[metrics] coverage-snapshot ${res.statusCode}: ${(await res.body.text()).slice(0, 120)}`);
    else await res.body.text();
  } catch (e) {
    console.warn(`[metrics] coverage-snapshot post failed: ${e instanceof Error ? e.message : e}`);
  }
}
