import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * AI normalization of CSV import drafts. Single batched Claude call per
 * upload — sends every row with the canonical lab/patient lists and asks
 * for spelling/capitalization fixes only. Returns one suggestion per row.
 *
 * The model is deliberately constrained: it can ONLY pick from the lists
 * we provide. No free-form invention. Low temperature for determinism.
 */

const SYSTEM_PROMPT = `You normalize messy CSV rows from a lab shipping log. For each row you receive:
- a raw lab/carrier name (often misspelled, miscapitalized, abbreviated)
- a raw patient name (same)

You return the canonical match for each, with a confidence score.

RULES (do not violate these):
1. For lab_suggested: you MUST pick a value EXACTLY from the provided "known_labs" list, OR return null if no lab in the list is a plausible match. Never invent.
2. For patient_suggested: you MUST pick a value EXACTLY from the provided "known_patients" list, OR return null if no plausible match. Pure capitalization fixes are allowed for patient names not in the list — in that case return the cleanly-cased version of the input.
3. Confidence is 0.0 to 1.0. 0.95+ = obvious typo/case fix to a known value. 0.7–0.94 = strong match but slight ambiguity. <0.7 = guessing — prefer null instead.
4. If raw input is already exactly correct, return it unchanged with confidence 1.0.
5. Output ONLY a JSON object — no prose, no code fences. Schema:
{
  "results": [
    {
      "row_key": "string",
      "lab_suggested": "string|null",
      "lab_confidence": 0.0,
      "patient_suggested": "string|null",
      "patient_confidence": 0.0,
      "reason": "short explanation, <80 chars"
    }
  ]
}`;

export type NormalizeInputRow = {
  rowKey: string;
  rawLab: string;
  rawPatient: string;
};

export type NormalizeResult = {
  rowKey: string;
  labSuggested: string | null;
  labConfidence: number;
  patientSuggested: string | null;
  patientConfidence: number;
  reason: string;
};

let cached: Anthropic | null = null;
function getClient(): Anthropic {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  cached = new Anthropic({ apiKey: key });
  return cached;
}

function stripFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith("`")) return t;
  return t
    .replace(/^`{3}(?:json)?\s*/i, "")
    .replace(/`{3}\s*$/i, "")
    .trim();
}

export async function aiNormalizeDrafts(input: {
  rows: NormalizeInputRow[];
  knownLabs: string[];
  knownPatients: string[];
}): Promise<NormalizeResult[]> {
  if (input.rows.length === 0) return [];

  const client = getClient();
  const userContent = JSON.stringify(
    {
      known_labs: input.knownLabs,
      // Cap patient list to a reasonable size to keep token costs bounded —
      // recent patients matter more than ancient ones.
      known_patients: input.knownPatients.slice(0, 400),
      rows: input.rows.map((r) => ({
        row_key: r.rowKey,
        raw_lab: r.rawLab,
        raw_patient: r.rawPatient,
      })),
    },
    null,
    2,
  );

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    // Cache the system prompt so re-uploads of the same shape get a hit.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI returned no text");
  }
  const raw = stripFence(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const obj = parsed as { results?: unknown };
  if (!Array.isArray(obj.results)) {
    throw new Error("AI response missing 'results' array");
  }

  const out: NormalizeResult[] = [];
  for (const r of obj.results as Array<Record<string, unknown>>) {
    if (typeof r.row_key !== "string") continue;
    out.push({
      rowKey: r.row_key,
      labSuggested:
        typeof r.lab_suggested === "string" && r.lab_suggested.trim()
          ? r.lab_suggested
          : null,
      labConfidence:
        typeof r.lab_confidence === "number"
          ? Math.max(0, Math.min(1, r.lab_confidence))
          : 0,
      patientSuggested:
        typeof r.patient_suggested === "string" && r.patient_suggested.trim()
          ? r.patient_suggested
          : null,
      patientConfidence:
        typeof r.patient_confidence === "number"
          ? Math.max(0, Math.min(1, r.patient_confidence))
          : 0,
      reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "",
    });
  }
  return out;
}
