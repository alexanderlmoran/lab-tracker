import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult, ProbeCandidate } from "./base.js";
import { normalizeDob } from "./base.js";

const LOGIN_URL = "https://api.vibrant-wellness.com/v1/portal/trans-service/valogin/login";
const FIND_PATIENT_URL = "https://api.vibrant-wellness.com/v1/portal/trans-service/trans/findPatient";
const REPORT_STATUS_BASE = "https://api.vibrant-wellness.com/v1/lis/base-report-service/result/getReportStatusListV2";
const PDF_ENGINE_URL = "https://api.vibrant-america.com/v1/report-pdf-engine/pdf";
// The portal's "Download all reports" renders the WHOLE order (every finished
// section) as one PDF via the AllSummaryReport route. Learned from a HAR capture
// 2026-06-08 (captures/vibrant/20260608-095759): the old per-section CUSTOM route
// needs codes like "OAC.cbrf-OSU.cbrf-CDZ.cbrf" (hyphen-joined, ".cbrf" suffix) —
// bare comma-joined short_names ("OAC,OSU,CDZ") return a REPORT_TYPE_..._NOT_EXIST
// error page. AllSummaryReport needs no section codes, so we use it for everything.
const ALL_SUMMARY_BASE = "https://report.vibrant-wellness.com/#/printable/AllSummaryReport";

// TODO: Confirm VIBRANT_CLINIC_ID if account ever becomes multi-clinic; currently 128164 per HAR.
const CENTNER_CLINIC_ID = 128164;

const USERNAME = process.env.VIBRANT_USERNAME;
const PASSWORD = process.env.VIBRANT_PASSWORD;

type ReportStatusEntry = {
  short_name: string;
  report_staus: string; // note: Vibrant typo "staus"
  final_report_date?: string;
  final_sample_collection_date?: string;
};

// getReportStatusListV2 buckets each section by stage. An order is COMPLETE only
// when every section is in finished_reports and the in-progress buckets are empty
// (verified from the captured response — see captures/vibrant/20260526-194948).
type ReportStatusResponse = {
  pending_reports?: ReportStatusEntry[];
  awaiting_samples_reports?: ReportStatusEntry[];
  analyzing_samples_reports?: ReportStatusEntry[];
  processing_reports?: ReportStatusEntry[];
  finished_reports?: ReportStatusEntry[];
  total_reports?: ReportStatusEntry[];
};

type FindPatientOrder = {
  accession_id: string;
};

type FindPatientEntry = {
  patient_id: number;
  patient_first_name: string;
  patient_last_name: string;
  patient_birthdate: string; // "YYYY-MM-DD"
  Order: FindPatientOrder[];
};

type FindPatientResponse = {
  total_count: number;
  patients: FindPatientEntry[];
};

async function login(): Promise<string> {
  const resp = await request(LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: USERNAME,
      password: PASSWORD,
      remember_me: false,
      log_in_device_id: null,
    }),
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`Vibrant login failed ${resp.statusCode}: ${body}`);
  }
  const json = (await resp.body.json()) as { token: string };
  return json.token;
}

// Per operator notes: single-clinic account — use login token directly.
// transferCustomerClinic is available as a defensive fallback if clinic selection
// is ever required; skipped here per operator guidance.
async function getEffectiveToken(loginToken: string): Promise<string> {
  // TODO: If multi-clinic support is needed, call
  // GET /v1/portal/trans-service/valogin/transferCustomerClinic?token=<loginToken>&clinic_id=<CENTNER_CLINIC_ID>
  // and return the new token from that response. For now the login token is sufficient.
  return loginToken;
}

async function findPatientByAccession(
  token: string,
  accessionId: string,
): Promise<FindPatientEntry | null> {
  const resp = await request(FIND_PATIENT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      kit_status: [],
      report_status: [],
      order_type: [],
      start_date: "",
      end_date: "",
      issue: [],
      search_patient_type: "accession_id",
      search_patient_field: accessionId,
      page: "1",
      perPage: "10",
      sorting_field_input: "patient_service_date",
      sorting_order_input: "desc",
      flagged: false,
    }),
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`findPatient (accession) failed ${resp.statusCode}: ${body}`);
  }
  const json = (await resp.body.json()) as FindPatientResponse;
  if (!json.patients || json.patients.length === 0) return null;
  // Find the patient whose Order array contains this accession
  return (
    json.patients.find((p) =>
      p.Order.some((o) => o.accession_id === accessionId),
    ) ?? null
  );
}

// TODO: The captured HAR only shows accession_id search. Patient-name search
// (search_patient_type="patient_name") is documented in operator notes but not
// HAR-confirmed. Enable below if accession match fails and operator confirms.
async function findPatientByName(
  token: string,
  patientName: string,
): Promise<FindPatientEntry[]> {
  const resp = await request(FIND_PATIENT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      kit_status: [],
      report_status: [],
      order_type: [],
      start_date: "",
      end_date: "",
      issue: [],
      search_patient_type: "patient_name",
      search_patient_field: patientName,
      page: "1",
      perPage: "25",
      sorting_field_input: "patient_service_date",
      sorting_order_input: "desc",
      flagged: false,
    }),
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`findPatient (name) failed ${resp.statusCode}: ${body}`);
  }
  const json = (await resp.body.json()) as FindPatientResponse;
  return json.patients ?? [];
}

async function getReportStatus(
  token: string,
  accessionId: string,
): Promise<ReportStatusResponse> {
  const url = `${REPORT_STATUS_BASE}?barcode=${encodeURIComponent(accessionId)}`;
  const resp = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`getReportStatusListV2 failed ${resp.statusCode}: ${body}`);
  }
  return (await resp.body.json()) as ReportStatusResponse;
}

// An order is complete only when every section finished and nothing is still
// pending/awaiting/analyzing/processing. This is the order-level completeness
// gate that lets the reconcile engine auto-post Vibrant safely (a finished
// SECTION alone never means a finished ORDER — Vibrant drips sections).
function isOrderComplete(s: ReportStatusResponse): boolean {
  const inProgress =
    (s.pending_reports?.length ?? 0) +
    (s.awaiting_samples_reports?.length ?? 0) +
    (s.analyzing_samples_reports?.length ?? 0) +
    (s.processing_reports?.length ?? 0);
  const finished = s.finished_reports?.length ?? 0;
  const total = s.total_reports?.length ?? 0;
  return inProgress === 0 && total > 0 && finished === total;
}

function parseUsDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

async function downloadPdf(
  token: string,
  accessionId: string,
): Promise<Buffer> {
  // Inner URL uses the double && separator (preserve verbatim) and the AllSummary
  // route — no sections param. localTimeZone is required for the render.
  const innerUrl =
    `${ALL_SUMMARY_BASE}/${accessionId}` +
    `?startPageNumber=1` +
    `&&localTimeZone=America/New_York` +
    `&&jwtToken=${encodeURIComponent(token)}`;

  const pdfUrl = `${PDF_ENGINE_URL}?url=${encodeURIComponent(innerUrl)}`;

  const resp = await request(pdfUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`pdf-engine failed ${resp.statusCode}: ${body}`);
  }
  const buf = Buffer.from(await resp.body.arrayBuffer());
  // Vibrant returns an error/not-ready page with HTTP 200 when the report or the
  // requested sections don't exist (e.g. "REPORT_TYPE_..._NOT_EXIST"). Only stage
  // a real PDF — otherwise the error HTML gets saved + surfaced in the review modal.
  const pdfStart = buf.indexOf("%PDF-");
  if (pdfStart < 0) {
    const head = buf.subarray(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
    throw new Error(`Vibrant report not a PDF (not ready / error): ${head.slice(0, 160)}`);
  }
  const pdf = buf.subarray(pdfStart);
  // Vibrant serves its "report not ready / sections don't exist" error as a TINY
  // valid PDF (~1KB) — it HAS %PDF- but is just the error text (e.g. JAMES FRANGI:
  // 879 bytes, "...REPORT_TYPE_..._NOT_EXIST"), so the %PDF- check alone lets it
  // through. A real lab report is many KB; reject anything implausibly small so we
  // never stage a blank/error card and instead keep searching for the real one.
  if (pdf.length < 10_000) {
    throw new Error(
      `Vibrant report not ready (only ${pdf.length} bytes — the not-ready/error page, not a result)`,
    );
  }
  return pdf;
}

function parseFinalDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // e.g. "Mon May 11 2026 06:09:28 GMT+0000 (Coordinated Universal Time)"
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export const vibrantScraper: LabScraper = {
  labName: "Vibrant",

  async run(_browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!USERNAME || !PASSWORD) {
      throw new Error("VIBRANT_USERNAME / VIBRANT_PASSWORD not configured");
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const loginToken = await login();
    const token = await getEffectiveToken(loginToken);

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    for (const c of openCases) {
      try {
        let accessionId: string | null = c.labExternalRef ?? null;
        let patientEntry: FindPatientEntry | null = null;

        if (accessionId) {
          // Accession given → match ONLY by that accession. Do NOT fall back to
          // name: findPatientByName + Order[0] would attach the patient's OTHER
          // lab when this accession's report isn't ready yet (patient-safety).
          // Skip and retry next cycle.
          patientEntry = await findPatientByAccession(token, accessionId);
        } else if (c.patientName) {
          // No accession on the case → match by patient name (+ DOB), but ONLY
          // when it's unambiguous: exactly one DOB-verified patient AND exactly
          // one order. A multi-order patient (or a DOB miss) is skipped rather
          // than risk attaching the wrong order's report (patient-safety). The
          // accession-less auto-feed and the manual "search for lab to post"
          // both land here; result-ready then writes the matched accession back.
          const candidates = await findPatientByName(token, c.patientName);
          const dobNorm = normalizeDob(c.patientDob);
          const dobMatches = dobNorm
            ? candidates.filter((p) => normalizeDob(p.patient_birthdate) === dobNorm)
            : candidates;
          patientEntry = dobMatches.length === 1 ? dobMatches[0] : null;
          if (patientEntry && patientEntry.Order.length === 1) {
            accessionId = patientEntry.Order[0].accession_id;
          } else {
            patientEntry = null; // ambiguous → leave for an accession set or manual upload
          }
        }

        if (!patientEntry || !accessionId) continue;

        const status = await getReportStatus(token, accessionId);
        const reports = status.finished_reports ?? [];
        if (reports.length === 0) continue;

        // Download the WHOLE order as one PDF (AllSummaryReport route — every
        // finished section, no per-section codes). isPartial below still flags
        // orders where not all sections are final, so the human reviews those.
        const pdfBuf = await downloadPdf(token, accessionId);

        found.push({
          caseId: c.caseId,
          labExternalRef: accessionId,
          pdfBase64: pdfBuf.toString("base64"),
          pdfFilename: `vibrant_${accessionId}.pdf`,
          resultIssuedAt: parseFinalDate(reports[0].final_report_date),
          isPartial: !isOrderComplete(status),
        });
      } catch (err) {
        errors.push({
          caseId: c.caseId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { found, errors };
  },

  // Patient-name search for the reconcile engine. Vibrant exposes DOB (so matches
  // are DOB-verified) but DRIPS sections — so we surface ONLY fully-complete
  // orders (isOrderComplete), letting the engine auto-post them like Access while
  // in-progress orders keep searching. Partials are never auto-finalized here.
  async probeByName(
    _browser: Browser,
    name: string,
    dob?: string | null,
  ): Promise<ProbeCandidate[]> {
    if (!USERNAME || !PASSWORD) {
      throw new Error("VIBRANT_USERNAME / VIBRANT_PASSWORD not configured");
    }
    const loginToken = await login();
    const token = await getEffectiveToken(loginToken);

    const candidates = await findPatientByName(token, name);
    const dobNorm = normalizeDob(dob ?? null);
    const matched =
      dobNorm === ""
        ? candidates
        : candidates.filter((p) => normalizeDob(p.patient_birthdate) === dobNorm);

    const out: ProbeCandidate[] = [];
    for (const p of matched) {
      for (const o of p.Order ?? []) {
        const acc = o.accession_id;
        if (!acc) continue;
        let status: ReportStatusResponse;
        try {
          status = await getReportStatus(token, acc);
        } catch {
          continue;
        }
        if (!isOrderComplete(status)) continue; // drip-safe: full order only
        // Multi-section complete orders auto-post too now — AllSummaryReport
        // downloads every section in one PDF (no single-section restriction).
        const fin = status.finished_reports ?? [];
        const latestFinal = fin
          .map((r) => r.final_report_date)
          .filter(Boolean)
          .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())
          .at(-1);
        out.push({
          ref: acc,
          resultIssuedAt: parseFinalDate(latestFinal) ?? null,
          collectionDate: parseUsDate(fin[0]?.final_sample_collection_date),
          status: "Complete",
          dobConfirmed: dobNorm !== "",
        });
      }
    }
    return out;
  },
};

export default vibrantScraper;