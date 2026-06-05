import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";

export type ScrapeResult = {
  caseId: string;
  labExternalRef: string;
  pdfBase64: string;
  pdfFilename: string;
  resultIssuedAt?: string;
  /** Set true when the scraper KNOWS this is a partial/interim report (not the
   * full order). Drip labs (Vibrant/Access) are also force-staged partial by
   * scrape-all until per-portal completeness detection exists. */
  isPartial?: boolean;
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
