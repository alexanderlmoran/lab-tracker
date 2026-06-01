// Agentic lab-portal scraper: a LabScraper backed by the LLM browser agent
// (worker/src/agent/browser-agent.ts) instead of hardcoded selectors/endpoints.
//
// makeAgenticScraper(config) returns a drop-in LabScraper, so it slots into the
// same registry (server.ts) and result-ready pipeline as the HTTP scrapers.
// Per-portal cost is just a config entry — login URL, credential env keys, and
// a natural-language goal hint. The agent figures out the navigation live, so
// a portal redesign doesn't require a recapture.
//
// PDF capture: portals serve results either inline (application/pdf response)
// or as a download. We listen for both, validate the bytes start with "%PDF-",
// and hand the latest captured PDF to the agent's success signal.

import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright";
import type { OpenCase } from "../tracker-client.js";
import type { LabScraper, ScrapeResult, ScrapeRun } from "./base.js";
import { runBrowserAgent, type AgentCredentials } from "../agent/browser-agent.js";

export type AgenticPortalConfig = {
  /** Must match lab_cases.lab_name for this portal (e.g. "Cyrex"). */
  labName: string;
  loginUrl: string;
  /** env var names holding the portal credentials. */
  usernameEnv: string;
  passwordEnv: string;
  /** Portal-specific hint folded into the agent's goal (e.g. where results live). */
  goalHint?: string;
  maxStepsPerCase?: number;
};

function buildGoal(cfg: AgenticPortalConfig, c: OpenCase): string {
  const lines = [
    `Log into the ${cfg.labName} lab portal at ${cfg.loginUrl} and download the result PDF for this patient:`,
    `  Patient name: ${c.patientName}`,
    c.patientDob ? `  DOB: ${c.patientDob}` : null,
    c.labExternalRef ? `  Accession / order #: ${c.labExternalRef}` : `  (no accession on file — match by patient name${c.patientDob ? " + DOB" : ""})`,
    cfg.goalHint ? `\nPortal hint: ${cfg.goalHint}` : null,
    `\nOpen the most recent completed/final report for this patient and let it load so the PDF is served. Then finish.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Attach PDF capture to a page. Returns a getter for the latest captured PDF. */
function attachPdfCapture(page: Page): () => { buf: Buffer; source: string } | null {
  let captured: { buf: Buffer; source: string } | null = null;
  const isPdf = (buf: Buffer) => buf.length > 1024 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

  page.on("response", async (resp) => {
    try {
      const ct = resp.headers()["content-type"] ?? "";
      if (!ct.includes("application/pdf")) return;
      const body = await resp.body();
      if (isPdf(body)) captured = { buf: body, source: resp.url() };
    } catch {
      // streaming/aborted/viewer-eaten — ignore; download handler may still catch it.
    }
  });
  page.on("download", async (dl) => {
    try {
      const path = await dl.path();
      if (!path) return;
      const body = await readFile(path);
      if (isPdf(body)) captured = { buf: body, source: dl.url() };
    } catch {
      /* ignore */
    }
  });

  return () => captured;
}

export function makeAgenticScraper(cfg: AgenticPortalConfig): LabScraper {
  return {
    labName: cfg.labName,

    async run(browser: Browser, openCases: OpenCase[]): Promise<ScrapeRun> {
      const username = process.env[cfg.usernameEnv];
      const password = process.env[cfg.passwordEnv];
      if (!username || !password) {
        throw new Error(`${cfg.usernameEnv} / ${cfg.passwordEnv} not configured`);
      }
      const credentials: AgentCredentials = { username, password };
      const found: ScrapeResult[] = [];
      const errors: ScrapeRun["errors"] = [];

      for (const c of openCases) {
        // Fresh context per case → no cross-patient state leakage.
        const ctx = await browser.newContext({ acceptDownloads: true });
        const page = await ctx.newPage();
        page.on("dialog", (d) => d.accept().catch(() => {}));
        const getPdf = attachPdfCapture(page);

        try {
          await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          const outcome = await runBrowserAgent({
            page,
            goal: buildGoal(cfg, c),
            credentials,
            pdfBytes: () => getPdf()?.buf.length ?? 0,
            maxSteps: cfg.maxStepsPerCase,
            log: (m) => console.log(`    [agent ${c.caseId.slice(0, 8)}] ${m}`),
          });

          const pdf = getPdf();
          if (outcome.status === "success" && pdf) {
            const accession = c.labExternalRef?.trim() || "UNKNOWN";
            found.push({
              caseId: c.caseId,
              labExternalRef: accession,
              pdfBase64: pdf.buf.toString("base64"),
              pdfFilename: `${cfg.labName.toLowerCase()}_${accession}.pdf`,
            });
          } else if (outcome.status === "success" && !pdf) {
            errors.push({ caseId: c.caseId, message: "agent reported success but no PDF was captured" });
          } else {
            errors.push({ caseId: c.caseId, message: `agent ${outcome.status} after ${outcome.steps} steps: ${outcome.detail}` });
          }
        } catch (err) {
          errors.push({ caseId: c.caseId, message: err instanceof Error ? err.message : String(err) });
        } finally {
          await ctx.close();
        }
      }

      return { found, errors };
    },
  };
}

// ── Portal configs ──────────────────────────────────────────────────────────

export const cyrexScraper: LabScraper = makeAgenticScraper({
  labName: "Cyrex",
  loginUrl: "https://www.cyrexlabs.com/Home/tabid/40/Default.aspx",
  usernameEnv: "CYREX_USERNAME",
  passwordEnv: "CYREX_PASSWORD",
  goalHint:
    "This is the Cyrex site home page. First find and click the Login / clinician / provider sign-in link, then enter credentials. After login, go to the Results / Reports / Test Results area, find the patient's row, open the most recent finalized report, and let the PDF render.",
});
