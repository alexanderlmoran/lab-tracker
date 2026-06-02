// Recipe engine — the portal recipes (Phase 1: pure-HTTP portals as data).
// Phase 3 will move these into the DB behind the Settings → Scrapers UI; for now
// they live here so makeRecipeScraper() can register them in server.ts.

import type { LabRecipe } from "./types.js";

const GA_PARTNER = "https://glycanage-partner-prod-2aeayxbfla-ew.a.run.app";
const GA_REPORTING = "https://glycanage-reporting-prod-2aeayxbfla-ew.a.run.app";
const GA_ORIGIN = { origin: "https://partners.glycanage.com", referer: "https://partners.glycanage.com/" };
const DD_BASE = "https://www.doctorsdata.com";
const GDX_BASE = "https://www.gdx.net";

export const RECIPES: LabRecipe[] = [
  {
    key: "glycanage",
    labName: "GlycanAge",
    transport: "http",
    auth: {
      strategy: "firebase",
      config: {
        signinUrl: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyAtPKrUJ7hEy7G9E1Ju_FplScVrFSkXf2Q",
        tenantId: "partners-0ly75",
        emailEnv: "GLYCANAGE_USERNAME",
        passwordEnv: "GLYCANAGE_PASSWORD",
      },
    },
    discovery: {
      strategy: "rest-json",
      config: {
        url: `${GA_PARTNER}/dashboard/reports?limit=500&offset=0&sortKey=createdOn&sortDir=desc`,
        method: "GET",
        headers: GA_ORIGIN,
        dataPath: "data",
        map: { ref: "sample", name: "name", pdfRef: "id", resultIssuedAt: "dos" },
      },
    },
    pdf: {
      strategy: "http-get-stream-slice",
      config: {
        urlTemplate: `${GA_REPORTING}/download-stream/{pdfRef}?version=b2b-public-en-latest`,
        headers: GA_ORIGIN,
      },
    },
    match: { refLooksLike: "^GA-" },
    ready: { mode: "presence" }, // presence in /reports == finalized
  },
  {
    key: "doctorsdata",
    labName: "DoctorsData",
    transport: "http",
    auth: {
      strategy: "aspnet-form",
      config: {
        base: DD_BASE,
        homePath: "/",
        loginPath: "/LoginUser",
        accountEnv: "DOCTORSDATA_USERNAME",
        passwordEnv: "DOCTORSDATA_PASSWORD",
        clientVersion: "20240822",
        tokenPagePath: "/View_PatientResults",
        loginFields: { account: "LoginName", password: "Password", clientVersion: "ClientVersion" },
      },
    },
    discovery: {
      strategy: "datatables",
      config: {
        url: `${DD_BASE}/DynLoadData_PatientResults`,
        headers: { referer: `${DD_BASE}/View_PatientResults` },
        columns: [
          { data: "LabID" },
          { data: "PatientName" },
          { data: "ProductName" },
          { data: "DateReceivedUTC" },
          { data: "DateReleasedUTC" },
          { data: "5" },
          { data: "Status", searchable: false },
          { data: "7", searchable: false },
        ],
        fromDays: 730,
        lengthN: 100,
        map: { ref: "LabID", name: "PatientName", status: "Status", pdfRef: "ReportURL" },
      },
    },
    pdf: {
      strategy: "http-get",
      config: { base: DD_BASE, urlTemplate: "{base}{pdfRefRaw}", headers: { referer: `${DD_BASE}/View_PatientResults` } },
    },
    match: { refLooksLike: "^\\d{6}-" },
    ready: { equals: ["Completed"] },
  },
  {
    key: "genova",
    labName: "Genova",
    transport: "http",
    // reCAPTCHA+MFA login is not automatable — reuse a human-captured session.
    auth: {
      strategy: "session-cookies",
      config: { sessionPathEnv: "GENOVA_SESSION_PATH", domainMatch: "(^|\\.)gdx\\.net$" },
    },
    discovery: {
      strategy: "csrf-json",
      config: {
        tokenUrl: `${GDX_BASE}/mygdx`,
        tokenRegex: 'name="_csrf"\\s+content="([^"]+)"',
        headerName: "X-CSRF-TOKEN",
        url: `${GDX_BASE}/mygdx/json/all-activities`,
        startKey: "startDate",
        endKey: "endDate",
        lookbackDays: 120,
        bodyExtra: { query: null },
        map: {
          ref: "order.orderNo",
          nameLast: "patientLastName",
          nameFirst: "patientFirstName",
          dob: "patientDateOfBirth",
          status: "status",
          resultIssuedAt: "dateReleased",
        },
      },
    },
    pdf: {
      strategy: "http-get",
      config: { urlTemplate: `${GDX_BASE}/mygdx/webreporting/report?orderNo={ref}`, headers: { referer: `${GDX_BASE}/mygdx` } },
    },
    match: { refLooksLike: "^V\\d" },
    ready: { equals: ["Released"] },
  },
];

export function getRecipe(key: string): LabRecipe | undefined {
  return RECIPES.find((r) => r.key === key);
}
