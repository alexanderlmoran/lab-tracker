import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "./base.js";

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
};

type ReportStatusResponse = {
  finished_reports: ReportStatusEntry[];
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
): Promise<ReportStatusEntry[]> {
  const url = `${REPORT_STATUS_BASE}?barcode=${encodeURIComponent(accessionId)}`;
  const resp = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (resp.statusCode !== 200) {
    const body = await resp.body.text();
    throw new Error(`getReportStatusListV2 failed ${resp.statusCode}: ${body}`);
  }
  const json = (await resp.body.json()) as ReportStatusResponse;
  return json.finished_reports ?? [];
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
  return buf;
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
          patientEntry = await findPatientByAccession(token, accessionId);
        }

        // TODO: fallback by patient name if no labExternalRef; operator notes say
        // search_patient_type="patient_name" works but was not HAR-captured for
        // clinic-portal flow. Uncomment and verify before enabling in production.
        if (!patientEntry && c.patientName) {
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

        const reports = await getReportStatus(token, accessionId);
        if (reports.length === 0) continue;

        // Pick the first finished report (most recently finalized).
        const report = reports[0];

        const pdfBuf = await downloadPdf(token, accessionId, report.short_name);

        found.push({
          caseId: c.caseId,
          labExternalRef: accessionId,
          pdfBase64: pdfBuf.toString("base64"),
          pdfFilename: `vibrant_${accessionId}_${report.short_name}.pdf`,
          resultIssuedAt: parseFinalDate(report.final_report_date),
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
};

export default vibrantScraper;