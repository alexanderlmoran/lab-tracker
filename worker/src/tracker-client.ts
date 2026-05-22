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
