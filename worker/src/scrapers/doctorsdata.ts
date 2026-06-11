// Doctor's Data (DDI) portal scraper.
//
// Target: https://www.doctorsdata.com/ — a classic ASP.NET MVC app. Login is a
// plain Account ID + Password form (NO CAPTCHA), so this is fully self-contained
// pure-HTTP (undici + a small cookie jar); no browser, no persisted session.
// Captured 2026-06-02 via lab-portal-capture.
//
// Flow:
//   1. GET  /                      -> establish session cookies (ASP.NET_SessionId,
//                                     __RequestVerificationToken cookie).
//   2. POST /LoginUser             -> LoginName/Password/ClientVersion; sets
//                                     .ASPXAUTH + AuthToken (302 on success).
//   3. GET  /View_PatientResults   -> scrape the anti-forgery FORM token
//                                     (<input name="__RequestVerificationToken">).
//   4. POST /DynLoadData_PatientResults (jQuery DataTables; needs the form token in
//      the body or it 302s) -> {data:[{LabID, PatientName, Status, ReportURL, …}]}.
//   5. GET  <ReportURL> (e.g. /DownloadReport?ReportID=U260416-2206-1) -> PDF.
// Match by accession/LabID (stored labExternalRef) or patient name. LabID
// ("260416-2206") is stored as labExternalRef; Status "Completed" = ready.

import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult, ProbeCandidate } from "./base.js";

const BASE = "https://www.doctorsdata.com";
const ACCOUNT = process.env.DOCTORSDATA_USERNAME;
const PASSWORD = process.env.DOCTORSDATA_PASSWORD;
const CLIENT_VERSION = "20240822";

type DdRow = {
  LabID?: string;
  PatientName?: string;
  ProductName?: string;
  Status?: string;
  ReportURL?: string | null;
  ReportReadStatus?: boolean;
  DateReceivedUTC?: string;
  DateReleasedUTC?: string;
};

class CookieJar {
  private jar = new Map<string, string>();
  absorb(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export const doctorsdataScraper: LabScraper = {
  labName: "DoctorsData",

  async run(_browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!ACCOUNT || !PASSWORD) {
      throw new Error("DOCTORSDATA_USERNAME / DOCTORSDATA_PASSWORD not configured");
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const jar = new CookieJar();
    await login(jar);
    const token = await getFormToken(jar);

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    for (const c of openCases) {
      try {
        // Search by stored accession if we have it, else by patient last name.
        const term = c.labExternalRef ?? lastNameOf(c.patientName);
        const rows = await fetchResults(jar, token, term);

        const match = matchRow(c, rows);
        if (!match || !match.ReportURL) continue;
        if (!isReady(match)) continue;

        const buf = await fetchReport(jar, match.ReportURL);
        found.push({
          caseId: c.caseId,
          labExternalRef: match.LabID ?? term,
          pdfBase64: buf.toString("base64"),
          pdfFilename: `doctorsdata_${normalizeName(match.PatientName ?? "").replace(/\s+/g, "_")}_${match.LabID ?? "report"}.pdf`,
          portalPatientName: match.PatientName ?? undefined,
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

  // Patient-name search for the reconcile engine. DoctorsData exposes NO DOB, so
  // matches are name-only (dobConfirmed:false) — the engine auto-posts only when
  // the exact LabID also matches the case; otherwise it flags for review. Returns
  // only ready+downloadable rows so a not-yet-released result cleanly "keeps
  // searching" rather than erroring on a failed download.
  async probeByName(
    _browser: Browser,
    name: string,
    _dob?: string | null,
  ): Promise<ProbeCandidate[]> {
    if (!ACCOUNT || !PASSWORD) {
      throw new Error("DOCTORSDATA_USERNAME / DOCTORSDATA_PASSWORD not configured");
    }
    const jar = new CookieJar();
    await login(jar);
    const token = await getFormToken(jar);
    const rows = await fetchResults(jar, token, lastNameOf(name));
    const nameNorm = normalizeName(name);
    return rows
      .filter(
        (r) => normalizeName(r.PatientName ?? "") === nameNorm && isReady(r) && !!r.ReportURL,
      )
      .map((r) => ({
        ref: r.LabID || null,
        resultIssuedAt: ddDate(r.DateReleasedUTC)?.iso ?? null,
        collectionDate: ddDate(r.DateReceivedUTC)?.us ?? ddDate(r.DateReleasedUTC)?.us ?? null,
        status: r.Status || "Completed",
        dobConfirmed: false,
      }));
  },
};

// DoctorsData dates arrive as ASP.NET "/Date(ms)/", ISO, or M/D/YYYY depending on
// the column. Parse defensively → { iso: YYYY-MM-DD, us: MM/DD/YYYY }.
function ddDate(s: string | undefined): { iso: string; us: string } | null {
  if (!s) return null;
  let d: Date | null = null;
  const ms = s.match(/\/Date\((\d+)\)\//);
  if (ms) d = new Date(Number(ms[1]));
  else {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) d = new Date(t);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split("-");
  return { iso, us: `${m}/${day}/${y}` };
}

async function login(jar: CookieJar): Promise<void> {
  const home = await request(`${BASE}/`, { method: "GET", headers: { accept: "text/html" } });
  jar.absorb(home.headers["set-cookie"]);
  await home.body.dump();

  const body = `LoginName=${encodeURIComponent(ACCOUNT!)}&Password=${encodeURIComponent(PASSWORD!)}&ClientVersion=${CLIENT_VERSION}`;
  const res = await request(`${BASE}/LoginUser`, {
    method: "POST",
    headers: {
      cookie: jar.header(),
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      referer: `${BASE}/`,
    },
    body,
  });
  jar.absorb(res.headers["set-cookie"]);
  await res.body.dump();
  // 302 = success (redirect into the app); 200 usually means the login page re-rendered.
  if (res.statusCode !== 302 && res.statusCode !== 200) {
    throw new Error(`DoctorsData login failed ${res.statusCode}`);
  }
}

async function getFormToken(jar: CookieJar): Promise<string> {
  const res = await request(`${BASE}/View_PatientResults`, {
    method: "GET",
    headers: { cookie: jar.header(), accept: "text/html", referer: `${BASE}/` },
  });
  jar.absorb(res.headers["set-cookie"]);
  const html = await res.body.text();
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  if (!m) {
    throw new Error("DoctorsData: no anti-forgery token on /View_PatientResults (login failed?)");
  }
  return m[1];
}

async function fetchResults(jar: CookieJar, token: string, searchTerm: string): Promise<DdRow[]> {
  const res = await request(`${BASE}/DynLoadData_PatientResults`, {
    method: "POST",
    headers: {
      cookie: jar.header(),
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer: `${BASE}/View_PatientResults`,
    },
    body: buildDataTablesBody(searchTerm, token),
  });
  if (res.statusCode !== 200) {
    await res.body.dump();
    throw new Error(`DoctorsData results failed ${res.statusCode} (session/token expired?)`);
  }
  const json = (await res.body.json()) as { data?: DdRow[] };
  return json.data ?? [];
}

async function fetchReport(jar: CookieJar, reportPath: string): Promise<Buffer> {
  const url = reportPath.startsWith("http") ? reportPath : `${BASE}${reportPath}`;
  const res = await request(url, {
    method: "GET",
    headers: { cookie: jar.header(), referer: `${BASE}/View_PatientResults` },
  });
  if (res.statusCode !== 200) {
    await res.body.dump();
    throw new Error(`DoctorsData report failed ${res.statusCode}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`DoctorsData report was not a PDF (session expired?)`);
  }
  return buf;
}

// Build the DataTables server-side body (8 columns, matching the captured grid),
// with a wide date window so older results are in range.
function buildDataTablesBody(searchTerm: string, token: string): string {
  const cols = ["LabID", "PatientName", "ProductName", "DateReceivedUTC", "DateReleasedUTC", "5", "Status", "7"];
  const parts: string[] = ["draw=1"];
  cols.forEach((data, i) => {
    const searchable = i === 6 || i === 7 ? "false" : "true";
    parts.push(
      `columns%5B${i}%5D%5Bdata%5D=${encodeURIComponent(data)}`,
      `columns%5B${i}%5D%5Bname%5D=${i >= 5 && (i === 5 || i === 7) ? "" : encodeURIComponent(data)}`,
      `columns%5B${i}%5D%5Bsearchable%5D=${searchable}`,
      `columns%5B${i}%5D%5Borderable%5D=${searchable}`,
      `columns%5B${i}%5D%5Bsearch%5D%5Bvalue%5D=`,
      `columns%5B${i}%5D%5Bsearch%5D%5Bregex%5D=false`,
    );
  });
  const to = formatMdY(new Date());
  const from = formatMdY(new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)); // ~2 years
  parts.push(
    "order%5B0%5D%5Bcolumn%5D=0",
    "order%5B0%5D%5Bdir%5D=desc",
    "start=0",
    "length=100",
    `search%5Bvalue%5D=${encodeURIComponent(searchTerm)}`,
    "search%5Bregex%5D=false",
    `__RequestVerificationToken=${encodeURIComponent(token)}`,
    `from=${encodeURIComponent(from)}`,
    `to=${encodeURIComponent(to)}`,
    "firstName=",
    "lastName=",
    "tblMain_length=100",
  );
  return parts.join("&");
}

function formatMdY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function isReady(r: DdRow): boolean {
  return /complete/i.test(r.Status ?? "");
}

function matchRow(c: OpenCase, rows: DdRow[]): DdRow | null {
  if (c.labExternalRef) {
    // An accession was entered → ONLY its exact result may match. No name
    // fallback: when this accession's report isn't released yet, a name match
    // would grab the patient's OTHER order — the wrong lab (patient-safety).
    return rows.find((r) => r.LabID?.trim() === c.labExternalRef!.trim()) ?? null;
  }
  // No accession: DoctorsData exposes no DOB, so the name is the only key.
  // Require it to be UNAMBIGUOUS — exactly one row in the search window —
  // else skip; two same-name patients/orders can't be told apart here.
  const nameNorm = normalizeName(c.patientName);
  const matches = rows.filter((r) => normalizeName(r.PatientName ?? "") === nameNorm);
  return matches.length === 1 ? matches[0] : null;
}

function lastNameOf(patientName: string): string {
  const clean = patientName.replace(/[^a-zA-Z, ]/g, "").trim();
  if (clean.includes(",")) return clean.split(",")[0].trim();
  const parts = clean.split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : clean;
}

function normalizeName(s: string): string {
  // "RYAN BLAIR" / "Blair, Ryan" / "Ryan Blair" → "blair ryan"
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}
