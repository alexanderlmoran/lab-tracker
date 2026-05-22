import type { Browser } from "playwright";
import type { OpenCase } from "../tracker-client.js";

export type ScrapeResult = {
  caseId: string;
  labExternalRef: string;
  pdfBase64: string;
  pdfFilename: string;
  resultIssuedAt?: string;
};

export type ScrapeRun = {
  found: ScrapeResult[];
  errors: Array<{ caseId: string; message: string }>;
};

export interface LabScraper {
  /** The labName value in lab_cases that this scraper handles (e.g. "Access"). */
  labName: string;
  /** Run a scrape pass against the lab portal for the given open cases. */
  run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun>;
}
