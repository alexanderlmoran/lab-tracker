import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";

/**
 * Canonical DOB normalizer shared by every scraper — DO NOT reimplement per
 * portal. Returns "YYYY-MM-DD". Accepts the tracker's ISO form and US
 * M/D/YYYY with OR WITHOUT zero-padding (portals vary: "3/5/1990" and
 * "03/05/1990" must both match). Historically access.ts/vibrant.ts required
 * zero-padding and silently failed unpadded dates — a wrong-patient-match risk.
 */
export function normalizeDob(s: string | null | undefined): string {
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s.trim();
}

export type ScrapeResult = {
  caseId: string;
  labExternalRef: string;
  pdfBase64: string;
  pdfFilename: string;
  resultIssuedAt?: string;
  /** The sample-collection date the LAB's report carries (YYYY-MM-DD), when the
   * scraper can parse it. This is the authoritative "Date Collected/Ordered" —
   * result-ready writes it onto the case so the PB post is dated by the real
   * collection (not the Zenoti booking, and never the scrape day). */
  collectionDate?: string | null;
  /** Set true when the scraper KNOWS this is a partial/interim report (not the
   * full order). Drip labs (Vibrant/Access) are also force-staged partial by
   * scrape-all until per-portal completeness detection exists. */
  isPartial?: boolean;
  /** The patient name as the PORTAL shows it for the matched row. Passed to
   * result-ready, which REJECTS the stage when the last name doesn't match the
   * case's patient — the server-side guard against a scraper mismatch. */
  portalPatientName?: string;
};

export type ScrapeRun = {
  found: ScrapeResult[];
  errors: Array<{ caseId: string; message: string }>;
};

/** A candidate result surfaced by a name-search, WITHOUT downloading the PDF.
 *  Powers the find-result / probe path so aged results surface cheaply. */
export type ProbeCandidate = {
  /** Accession / order number (the value staff would write onto the case). */
  ref: string | null;
  /** ISO date the result was finalized, if parseable. */
  resultIssuedAt: string | null;
  /** Collection date as shown in the portal (MM/DD/YYYY), for disambiguation. */
  collectionDate: string | null;
  /** Portal status string, e.g. "Complete". */
  status: string;
  /** True only if this candidate's DOB was checked against the requested DOB and
   *  matched. Portals that don't expose DOB (GlycanAge, DoctorsData) leave this
   *  false/undefined so the reconcile engine grades them as a NAME-ONLY match
   *  (not name+DOB) — preventing a confident auto-post on a name collision. */
  dobConfirmed?: boolean;
};

export interface LabScraper {
  /** The labName value in lab_cases that this scraper handles (e.g. "Access"). */
  labName: string;
  /** Run a scrape pass against the lab portal for the given open cases. */
  run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun>;
  /** Optional: list candidate results for a patient by NAME (no PDF download).
   *  When present, the worker's /probe endpoint prefers this over a full run —
   *  so the find-result button can surface aged results without pulling every
   *  PDF. Returns ready + not-ready candidates; caller decides what to show. */
  probeByName?(
    browser: Browser,
    name: string,
    dob?: string | null,
  ): Promise<ProbeCandidate[]>;
}
