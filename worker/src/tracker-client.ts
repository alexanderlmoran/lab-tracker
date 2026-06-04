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
  source: string;
  /** When true the tracker marks step 2 (partial received) instead of step 4
   * (complete) — so a drip lab (Vibrant/Access) can't auto-complete a case off
   * a partial report. The result-ready route already understands this flag. */
  isPartial?: boolean;
  /** Reconciliation engine: approve + enqueue the PB upload without a human
   * click (only set when the capture graded ≥ the auto-post threshold). */
  autoApprove?: boolean;
  /** Capture-confidence score (0-100), recorded for audit/flag context. */
  confidence?: number;
};

export async function postResultReady(payload: ResultReadyPayload): Promise<void> {
  const res = await request(`${BASE}/api/worker/result-ready`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`result-ready failed ${res.statusCode}: ${body}`);
  }
}
