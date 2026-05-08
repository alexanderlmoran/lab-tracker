import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { InboundEmailExtracted } from "@/lib/types";

const SYSTEM_INSTRUCTIONS = `You extract structured data from lab-test reports for a medical practice (Centner Wellness).
Reports come from these labs (each with its own format): Access, Cyrex, Spectracell, Genova, GlycanAge, Vibrant America (Vibrant), Doctors Data.

Return ONLY a JSON object matching this exact shape (omit fields you cannot determine; do not invent):
{
  "lab_name": "Quest" | "Cyrex" | "Spectracell" | "Genova" | "GlycanAge" | "Vibrant" | "Doctors Data" | "Access" | "Other",
  "patient_name": "Full Name as printed on report",
  "patient_email": "...if present...",
  "patient_dob": "YYYY-MM-DD",
  "test_panel": "Panel or test code (e.g. 'Wheat/Gluten Reactivity', 'Comprehensive Stool Analysis')",
  "result_kind": "partial" | "complete" | "unknown",
  "collected_date": "YYYY-MM-DD",
  "reported_date": "YYYY-MM-DD",
  "summary": "One short sentence describing the report contents."
}

Guidance:
- "result_kind" = "partial" if the report explicitly says interim/preliminary/partial, otherwise "complete" if it contains finalized results, otherwise "unknown".
- Use ISO dates. If a date is ambiguous, omit it rather than guess.
- Output strict JSON. No prose. No code fences.`;

let cached: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  cached = new Anthropic({ apiKey: key });
  return cached;
}

function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("\`\`\`")) {
    return trimmed
      .replace(/^\`\`\`(?:json)?\s*/i, "")
      .replace(/\s*\`\`\`\s*$/i, "")
      .trim();
  }
  return trimmed;
}

export async function parseLabReportWithClaude(args: {
  subject?: string | null;
  fromAddress?: string | null;
  bodyText?: string | null;
  attachmentTexts: Array<{ filename: string; text: string }>;
}): Promise<InboundEmailExtracted> {
  const client = getAnthropic();

  const attachmentBlock =
    args.attachmentTexts.length === 0
      ? "(no attachments)"
      : args.attachmentTexts
          .map(
            (a, i) =>
              `--- ATTACHMENT ${i + 1}: ${a.filename} ---\n${a.text}\n--- END ATTACHMENT ${i + 1} ---`,
          )
          .join("\n\n");

  const userContent = `EMAIL METADATA
From: ${args.fromAddress ?? "(unknown)"}
Subject: ${args.subject ?? "(none)"}

EMAIL BODY
${args.bodyText?.trim() ?? "(empty)"}

${attachmentBlock}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    // Cache the system instructions — every parse call uses the same prompt,
    // so cache hits cut latency and cost on subsequent uploads.
    system: [
      {
        type: "text",
        text: SYSTEM_INSTRUCTIONS,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  const raw = stripJsonFence(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
  return parsed as InboundEmailExtracted;
}
