// GlycanAge partner portal scraper.
//
// Target: https://partners.glycanage.com/ — a modern SPA backed by a clean REST
// API on Google Cloud Run, with Firebase email/password auth (NO CAPTCHA). So
// this is a fully self-contained pure-HTTP scraper (like vibrant.ts): it logs in
// itself; no persisted session needed. Captured 2026-06-02 via lab-portal-capture.
//
// Flow:
//   1. POST identitytoolkit signInWithPassword (email+password) -> Firebase idToken.
//   2. GET  {API}/dashboard/reports?limit=…  (Bearer idToken) -> {total, data:[…]}.
//      Each report: id (=download id), name (patient), sample ("GA-US-030967"),
//      dos (date of service). Presence in /reports == finalized/downloadable.
//   3. GET  {REPORTING}/download-stream/<report.id>?version=b2 (Bearer) -> PDF.
// Match by sample/kit id (stored labExternalRef) or patient name.

import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "./base.js";

// Public Firebase web API key (embedded in the SPA — not a secret).
const FIREBASE_KEY = "AIzaSyAtPKrUJ7hEy7G9E1Ju_FplScVrFSkXf2Q";
// GlycanAge uses Firebase multi-tenancy — the partner accounts live in this
// tenant, so signInWithPassword MUST include it or it returns INVALID_LOGIN_CREDENTIALS.
const FIREBASE_TENANT_ID = "partners-0ly75";
const SIGNIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`;
const API_BASE = "https://glycanage-partner-prod-2aeayxbfla-ew.a.run.app";
const REPORTING_BASE = "https://glycanage-reporting-prod-2aeayxbfla-ew.a.run.app";
// download-stream emits progress JSON ({"phase":"preparing"...}) then the PDF in
// one response; the version string must be exact or it never advances past prep.
const DOWNLOAD_VERSION = "b2b-public-en-latest";
const EMAIL = process.env.GLYCANAGE_USERNAME;
const PASSWORD = process.env.GLYCANAGE_PASSWORD;

type GaReport = {
  id: string; // download-stream id
  name?: string; // patient name, e.g. "David Centner "
  sample?: string; // kit id, e.g. "GA-US-030967"
  dos?: string; // date of service (ISO)
  createdOn?: string;
};

export const glycanageScraper: LabScraper = {
  labName: "GlycanAge",

  async run(_browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!EMAIL || !PASSWORD) {
      throw new Error("GLYCANAGE_USERNAME / GLYCANAGE_PASSWORD not configured");
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const token = await signIn();
    const reports = await fetchReports(token);

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    for (const c of openCases) {
      try {
        const match = matchReport(c, reports);
        if (!match) continue;

        const buf = await fetchPdf(token, match.id);
        const ref = match.sample || match.id;
        found.push({
          caseId: c.caseId,
          labExternalRef: ref,
          pdfBase64: buf.toString("base64"),
          pdfFilename: `glycanage_${normalizeName(match.name ?? "").replace(/\s+/g, "_")}_${ref}.pdf`,
          resultIssuedAt: (match.dos || match.createdOn)?.slice(0, 10),
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

async function signIn(): Promise<string> {
  const res = await request(SIGNIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      returnSecureToken: true,
      clientType: "CLIENT_TYPE_WEB",
      tenantId: FIREBASE_TENANT_ID,
    }),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`GlycanAge sign-in failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as { idToken?: string };
  if (!json.idToken) throw new Error("GlycanAge sign-in returned no idToken");
  return json.idToken;
}

async function fetchReports(token: string): Promise<GaReport[]> {
  // /reports is the finalized-report list; presence == downloadable. Pull a wide
  // page (total was 27 at capture) sorted newest-first.
  const url = `${API_BASE}/dashboard/reports?limit=500&offset=0&sortKey=createdOn&sortDir=desc`;
  const res = await request(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://partners.glycanage.com",
      referer: "https://partners.glycanage.com/",
    },
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`GlycanAge reports failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as { data?: GaReport[] };
  return json.data ?? [];
}

async function fetchPdf(token: string, reportId: string): Promise<Buffer> {
  const url = `${REPORTING_BASE}/download-stream/${encodeURIComponent(reportId)}?version=${DOWNLOAD_VERSION}`;
  const res = await request(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://partners.glycanage.com",
      referer: "https://partners.glycanage.com/",
    },
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`GlycanAge download ${reportId} failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  // Response = null-delimited progress JSON ({"phase":"preparing"...}) followed by
  // the raw PDF. Slice from the %PDF- marker to drop the progress prefix.
  const buf = Buffer.from(await res.body.arrayBuffer());
  const pdfStart = buf.indexOf("%PDF-");
  if (pdfStart < 0) {
    throw new Error(`GlycanAge download ${reportId} contained no PDF (stuck on: ${buf.subarray(0, 60).toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim()})`);
  }
  return buf.subarray(pdfStart);
}

function matchReport(c: OpenCase, reports: GaReport[]): GaReport | null {
  if (c.labExternalRef) {
    const byRef = reports.find((r) => r.sample?.trim() === c.labExternalRef!.trim());
    if (byRef) return byRef;
  }
  const nameNorm = normalizeName(c.patientName);
  return reports.find((r) => normalizeName(r.name ?? "") === nameNorm) ?? null;
}

function normalizeName(s: string): string {
  // "David Centner" / "Centner, David" / "DAVID CENTNER " → "centner david"
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}
