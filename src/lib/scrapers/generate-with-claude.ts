import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SlimHar } from "./har-slim";

// Generates a TypeScript scraper file from a slimmed HAR + the canonical
// Access scraper as the reference template. Claude reads request patterns
// + first-1KB-of-each-response and proposes runnable code.
//
// Prompt-caching strategy:
//   - SYSTEM_INSTRUCTIONS — cached (same across all portals)
//   - REFERENCE_SCRAPER_SOURCE — cached (same access.ts template)
//   - Per-call input: slimHar + portal metadata + user notes
// On the 2nd+ portal generation, the cached tokens are reused for cents
// per call instead of dollars.

const SYSTEM_INSTRUCTIONS = `You write TypeScript lab portal scrapers for the Centner Wellness lab-tracker worker process.

Each scraper implements the LabScraper interface from worker/src/scrapers/base.ts and follows the same architectural pattern as worker/src/scrapers/access.ts (provided as reference).

Constraints, in order of importance:
1. Output ONLY a single TypeScript module — no prose before or after. Output starts with imports and ends with the closing brace of the class. No code fences.
2. The class must export a default-named class implementing LabScraper.run().
3. Use Playwright (browser.newContext, ctx.route, page.goto) for portals whose result PDFs render inline (Chrome's built-in PDF viewer intercepts response.body() — bypass via ctx.route network interception, see access.ts).
4. Use undici (HTTP-only) for portals with a clean REST API or pre-signed S3 URLs (no Playwright needed at runtime). PracticeBetter uploader is the canonical example, but it's an uploader not a scraper.
5. Cookies / auth flow: replay the request sequence verbatim from the HAR. Do NOT invent endpoints not present in the capture.
6. Pattern matching openCases → lab PDFs: prefer accession # match first (case.labExternalRef), fall back to patient name + DOB (case.patientName / case.patientDob), with the fallback noted as a TODO comment if the HAR doesn't reveal an obvious search endpoint.
7. Return shape: { found: ScrapeResult[]; errors: { caseId; message }[] }. Each ScrapeResult must include caseId, labExternalRef, pdfBase64, pdfFilename, resultIssuedAt?.
8. Read pdf bytes with await response.body() (or arrayBuffer + base64 encode), never via filesystem.
9. Add // TODO: comments for anything you couldn't determine from the HAR.
10. Stay under 250 lines. Prefer clarity over completeness — the operator will fill in TODOs by hand.

Do NOT include:
- Tests
- Example invocations / main()
- console.log for happy-path success (errors-only logging is OK)
- ANY interaction with the tracker DB or PB — those are someone else's problem`;

const REFERENCE_SCRAPER_TEMPLATE_PROMPT = `REFERENCE SCRAPER (worker/src/scrapers/access.ts) — follow this pattern:

\`\`\`typescript
{{ACCESS_SOURCE}}
\`\`\`

REFERENCE TYPES (worker/src/scrapers/base.ts):

\`\`\`typescript
{{BASE_SOURCE}}
\`\`\`

REFERENCE TRACKER-CLIENT (worker/src/tracker-client.ts — for OpenCase shape):

\`\`\`typescript
{{TRACKER_CLIENT_SOURCE}}
\`\`\``;

let cached: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  cached = new Anthropic({ apiKey: key });
  return cached;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```(?:typescript|ts)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
  }
  return t;
}

export type GenerateScraperInput = {
  portalKey: string;
  portalLabName: string;
  portalLoginUrl: string;
  /** Free-text notes the operator typed during/after the capture. */
  operatorNotes: string;
  /** Slim HAR built from the captured session. */
  slimHar: SlimHar;
  /** Verbatim contents of worker/src/scrapers/access.ts. */
  accessReferenceSource: string;
  /** Verbatim contents of worker/src/scrapers/base.ts. */
  baseReferenceSource: string;
  /** Verbatim contents of worker/src/tracker-client.ts (for OpenCase shape). */
  trackerClientSource: string;
};

export type GenerateScraperResult = {
  /** The generated TypeScript module source. */
  source: string;
  /** Token usage info — for cost/observability. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
};

export async function generateScraperWithClaude(
  input: GenerateScraperInput,
): Promise<GenerateScraperResult> {
  const client = getAnthropic();

  const referenceSection = REFERENCE_SCRAPER_TEMPLATE_PROMPT
    .replace("{{ACCESS_SOURCE}}", input.accessReferenceSource)
    .replace("{{BASE_SOURCE}}", input.baseReferenceSource)
    .replace("{{TRACKER_CLIENT_SOURCE}}", input.trackerClientSource);

  // Per-portal user content: metadata + notes + slimmed HAR JSON.
  const userContent = `Portal to scaffold a scraper for:

PORTAL_KEY:       ${input.portalKey}
LAB_NAME:         ${input.portalLabName}
LOGIN_URL:        ${input.portalLoginUrl}

OPERATOR_NOTES (free-text captured during the recording — may be empty):
${input.operatorNotes.trim() || "(none provided)"}

SLIMMED_HAR (${input.slimHar.keptCount} of ${input.slimHar.entryCount} entries kept; static assets dropped):

\`\`\`json
${JSON.stringify(input.slimHar, null, 2)}
\`\`\`

Write the scraper now. Filename will be worker/src/scrapers/${input.portalKey}.ts.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text: SYSTEM_INSTRUCTIONS,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: referenceSection,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  const source = stripCodeFence(textBlock.text);

  return {
    source,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
