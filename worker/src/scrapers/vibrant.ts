import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult, ProbeCandidate } from "./base.js";

const LOGIN_URL = "https://api.vibrant-wellness.com/v1/portal/trans-service/valogin/login";
const FIND_PATIENT_URL = "https://api.vibrant-wellness.com/v1/portal/trans-service/trans/findPatient";
const REPORT_STATUS_BASE = "https://api.vibrant-wellness.com/v1/lis/base-report-service/result/getReportStatusListV2";
const PDF_ENGINE_URL = "https://api.vibrant-america.com/v1/report-pdf-engine/pdf";
const REPORT_VIEWER_BASE = "https://report.vibrant-wellness.com/#/printable/CUSTOM";

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
  shortName: string,
): Promise<Buffer> {
  // Per operator notes: inner URL uses double && separator — preserve verbatim.
  const innerUrl =
    `${REPORT_VIEWER_BASE}/${accessionId}` +
    `?sections=${encodeURIComponent(shortName)}` +
    `&&startPageNumber=1` +
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
  return buf.subarray(pdfStart);
}

function normalizeDob(s: string | null): string {
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  return s.trim();
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
          // No accession on the case → match by patient name (+ dob).
          const candidates = await findPatientByName(token, c.patientName);
          const dobNorm = normalizeDob(c.patientDob);
          patientEntry =
            candidates.find((p) => normalizeDob(p.patient_birthdate) === dobNorm) ??
            candidates[0] ??
            null;
          if (patientEntry && patientEntry.Order.length > 0) {
            accessionId = patientEntry.Order[0].accession_id;
          }
        }

        if (!patientEntry || !accessionId) continue;

        const status = await getReportStatus(token, accessionId);
        const reports = status.finished_reports ?? [];
        if (reports.length === 0) continue;

        // Download the FIRST finished section. Vibrant's multi-section URL format
        // is NOT comma-joined (sections=A,B,C → REPORT_TYPE_A,B,C_NOT_EXIST error)
        // and isn't yet known — so a multi-section order yields a VALID section-1
        // PDF (staged partial for human review), never an error page. Capturing a
        // real multi-section download to learn the format is a TASKS.md item.
        const primary = reports[0];
        if (reports.length > 1) {
          console.log(`[vibrant] order ${accessionId} has ${reports.length} sections; downloading first (${primary.short_name}) only — multi-section format TBD`);
        }
        const pdfBuf = await downloadPdf(token, accessionId, primary.short_name);

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
        // Auto-post only SINGLE-section orders — run() can only download a valid
        // full PDF for those (multi-section download format is unknown; see above).
        // Multi-section complete orders stay "keep searching" → handled by
        // scrape-all as a section-1 partial for human review, never auto-posted.
        if ((status.total_reports?.length ?? 0) !== 1) continue;
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