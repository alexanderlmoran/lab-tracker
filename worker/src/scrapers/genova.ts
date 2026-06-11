// Genova Diagnostics (GDX / mygdx) portal scraper.
//
// Target: https://www.gdx.net/mygdx/ . Captured 2026-06-02 via lab-portal-capture.
//
// Login is gated by reCAPTCHA (image challenge) + MFA — deliberately NOT
// automatable. So Genova uses the SAME session-reuse model as the Zenoti sync
// (src/zenoti/fetch-browser.ts): a human logs in once (solving the CAPTCHA),
// we persist the Playwright storage.json, and this scraper reuses those cookies
// over plain HTTP (undici). No browser at runtime. When the session expires the
// activities/report calls 401/redirect — re-run the capture to refresh:
//   bash ~/.claude/skills/lab-portal-capture/capture.sh genova 'https://www.gdx.net/mygdx/login'
// and point GENOVA_SESSION_PATH at the new storage.json.
//
// Two HTTP calls (both need only the gdx.net session cookies):
//   - POST /mygdx/json/all-activities {startDate,endDate,query} -> activity list
//     (patientFirstName/LastName/DOB, order.orderNo, status "Released" = ready).
//   - GET  /mygdx/webreporting/report?orderNo=<orderNo>         -> application/pdf
// Match by order# (stored labExternalRef) or patient name + DOB. orderNo (e.g.
// "V7160106") is stored as labExternalRef.

import { readFile } from "node:fs/promises";
import { request } from "undici";
import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeRun, ScrapeResult } from "./base.js";
import { normalizeDob } from "./base.js";

const BASE = "https://www.gdx.net";
const SESSION_PATH = process.env.GENOVA_SESSION_PATH;
const LOOKBACK_DAYS = Number(process.env.GENOVA_LOOKBACK_DAYS ?? "120");

type StorageCookie = { name: string; value: string; domain: string };
type StorageJson = { cookies: StorageCookie[] };

type GdxActivity = {
  order?: { orderNo?: string };
  patientFirstName?: string;
  patientLastName?: string;
  patientDateOfBirth?: string; // YYYY-MM-DD
  dateReleased?: string;
  dateCollected?: string;
  status?: string; // "Released" when finalized
};

export const genovaScraper: LabScraper = {
  labName: "Genova",

  async run(_browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
    if (!SESSION_PATH) {
      throw new Error(
        "GENOVA_SESSION_PATH not configured — point it at a Playwright storage.json with a live gdx.net session",
      );
    }
    if (openCases.length === 0) return { found: [], errors: [] };

    const cookie = await loadCookieHeader(SESSION_PATH);
    const activities = await fetchActivities(cookie);

    const found: ScrapeResult[] = [];
    const errors: ScrapeRun["errors"] = [];

    for (const c of openCases) {
      try {
        const match = matchActivity(c, activities);
        if (!match) continue;
        if (!isReady(match)) continue;
        const orderNo = match.order?.orderNo;
        if (!orderNo) continue;

        const buf = await fetchReport(cookie, orderNo);
        found.push({
          caseId: c.caseId,
          labExternalRef: orderNo,
          pdfBase64: buf.toString("base64"),
          pdfFilename: `genova_${normalizeName(`${match.patientLastName}, ${match.patientFirstName}`).replace(/\s+/g, "_")}_${orderNo}.pdf`,
          resultIssuedAt: match.dateReleased || undefined,
          portalPatientName: `${match.patientFirstName ?? ""} ${match.patientLastName ?? ""}`.trim() || undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A non-PDF report body = the session died mid-run. Abort the WHOLE run
        // loudly (a lab-level error in scrape-all / /run) instead of burying it
        // as a per-case error that reads like "not ready" — the old masking bug.
        if (/session (may have )?expired/i.test(message)) throw err;
        errors.push({ caseId: c.caseId, message });
      }
    }

    return { found, errors };
  },
};

async function loadCookieHeader(storagePath: string): Promise<string> {
  const raw = await readFile(storagePath, "utf-8");
  const parsed = JSON.parse(raw) as StorageJson;
  const matching = parsed.cookies.filter((c) => /(^|\.)gdx\.net$/.test(c.domain));
  if (matching.length === 0) {
    throw new Error(`No gdx.net cookies in ${storagePath} — Genova session may have expired`);
  }
  return matching.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Spring Security CSRF token — required on POSTs (GETs are exempt). It is NOT a
// cookie here; it's embedded as <meta name="_csrf" content="..."> in the page.
async function fetchCsrfToken(cookie: string): Promise<string> {
  const res = await request(`${BASE}/mygdx`, {
    method: "GET",
    headers: { cookie, referer: `${BASE}/mygdx` },
  });
  const html = await res.body.text();
  const m = html.match(/name="_csrf"\s+content="([^"]+)"/i);
  if (!m) {
    throw new Error("could not find _csrf token on /mygdx (Genova session expired?)");
  }
  return m[1];
}

async function fetchActivities(cookie: string): Promise<GdxActivity[]> {
  const csrf = await fetchCsrfToken(cookie);
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const body = JSON.stringify({
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    query: null,
  });
  const res = await request(`${BASE}/mygdx/json/all-activities`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      referer: `${BASE}/mygdx`,
      "x-requested-with": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrf,
    },
    body,
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`all-activities failed ${res.statusCode} (session expired?): ${text.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as GdxActivity[];
  return Array.isArray(json) ? json : [];
}

async function fetchReport(cookie: string, orderNo: string): Promise<Buffer> {
  const res = await request(`${BASE}/mygdx/webreporting/report?orderNo=${encodeURIComponent(orderNo)}`, {
    method: "GET",
    headers: { cookie, referer: `${BASE}/mygdx` },
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`report ${orderNo} failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`report ${orderNo} was not a PDF (session expired?)`);
  }
  return buf;
}

function isReady(a: GdxActivity): boolean {
  return /released/i.test(a.status ?? "") || !!a.dateReleased;
}

function matchActivity(c: OpenCase, activities: GdxActivity[]): GdxActivity | null {
  if (c.labExternalRef) {
    // An accession was entered → ONLY its exact order may match. No name
    // fallback: the patient's OTHER order would be the wrong lab.
    return activities.find((a) => a.order?.orderNo?.trim() === c.labExternalRef!.trim()) ?? null;
  }
  // No accession → name (+ DOB when both sides have it), and ONLY when
  // unambiguous: exactly one matching activity, else wait for an accession.
  const nameNorm = normalizeName(c.patientName);
  const dobNorm = normalizeDob(c.patientDob);
  const matches = activities.filter(
    (a) =>
      normalizeName(`${a.patientLastName ?? ""}, ${a.patientFirstName ?? ""}`) === nameNorm &&
      (dobNorm === "" || normalizeDob(a.patientDateOfBirth ?? null) === dobNorm),
  );
  return matches.length === 1 ? matches[0] : null;
}

function normalizeName(s: string): string {
  const clean = s.replace(/[^a-zA-Z, ]/g, "").trim().toLowerCase();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return `${last} ${first}`.trim();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[parts.length - 1]} ${parts[0]}`;
  return clean;
}
