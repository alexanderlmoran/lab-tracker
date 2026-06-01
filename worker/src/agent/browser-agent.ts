// Generic LLM-driven browser agent: perceive (live DOM) → decide (Claude
// tool-use) → act (Playwright), looping until the result PDF is captured or
// it gives up.
//
// Why agentic instead of a hardcoded scraper: the agent reads the LIVE page
// each step and chooses actions by GOAL, so a portal moving a button or
// renaming a URL doesn't break it the way a selector/endpoint scraper would —
// it just re-reads the new page. That's the "self-calibrating, no recapture"
// property we want for the long-tail portals.
//
// Security: the password is NEVER sent to the model. The agent calls
// fill_secret({index, which}); the harness injects the real value from the
// caller's credentials. The model only ever sees "username"/"password".

import Anthropic from "@anthropic-ai/sdk";
import type { ElementHandle, Page } from "playwright";

export type AgentCredentials = { username: string; password: string };

export type AgentOutcome = {
  status: "success" | "gave_up" | "max_steps" | "error";
  detail: string;
  steps: number;
};

export type RunBrowserAgentOpts = {
  page: Page;
  /** Natural-language task: what to log into, which patient/accession to find. */
  goal: string;
  credentials: AgentCredentials;
  /** Bytes of any PDF captured so far (0 = none). The caller wires the actual
   *  capture via a response/download listener; the agent only learns whether a
   *  PDF has arrived, which is its success signal. */
  pdfBytes: () => number;
  maxSteps?: number;
  model?: string;
  log?: (m: string) => void;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_STEPS = 30;

const SYSTEM = `You are a browser automation agent whose job is to retrieve ONE lab-result PDF from a medical lab portal.

Each turn you receive the page state: URL, title, a "PDF CAPTURED" status, a numbered list of interactive elements, and a snippet of visible text. Call EXACTLY ONE tool to act; you then receive the updated page state.

Rules:
- To log in, NEVER type credentials yourself. Call fill_secret with the field's index and which="username" or "password". The real values are injected securely and you will not see them.
- Work step by step toward the goal: log in → go to results/reports → find the row matching the patient name / accession in the goal → open or download its PDF.
- The PDF is captured automatically the instant the portal serves it. When "PDF CAPTURED" shows yes, call finish.
- If you get stuck (login fails, no matching result, a CAPTCHA, a dead end), call give_up with a specific reason. Never loop aimlessly.
- Click elements by their listed index. Use goto only for URLs you are confident about.`;

const tools: Anthropic.Tool[] = [
  {
    name: "goto",
    description: "Navigate to a URL.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "click",
    description: "Click the interactive element at the given index from the current page list.",
    input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
  },
  {
    name: "fill",
    description: "Type non-secret text into the input at the given index.",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer" }, text: { type: "string" } },
      required: ["index", "text"],
    },
  },
  {
    name: "fill_secret",
    description: "Securely fill a credential into the input at index. The value is injected by the harness; you never see it.",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer" }, which: { type: "string", enum: ["username", "password"] } },
      required: ["index", "which"],
    },
  },
  {
    name: "press",
    description: "Press a keyboard key (e.g. Enter) on the focused element.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "finish",
    description: "The result PDF has been captured (PDF CAPTURED: yes). End successfully.",
    input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  {
    name: "give_up",
    description: "Cannot complete the task. End with a specific reason.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

/** Enumerate visible interactive elements + page text into a model-friendly
 *  description, returning the handle list so click/fill can act by index. */
async function snapshot(page: Page, pdfBytes: number): Promise<{ text: string; handles: ElementHandle[] }> {
  let all: ElementHandle[] = [];
  try {
    all = await page.$$("a, button, input, select, textarea, [role=button], [role=link], [onclick], [contenteditable=true]");
  } catch {
    all = [];
  }
  const handles: ElementHandle[] = [];
  const lines: string[] = [];
  for (const h of all) {
    let vis = false;
    try {
      vis = await h.isVisible();
    } catch {
      vis = false;
    }
    if (!vis) continue;
    const idx = handles.length;
    handles.push(h);
    let info = { tag: "?", type: "", role: "", name: "", value: "" };
    try {
      info = await h.evaluate((node) => {
        const el = node as HTMLElement;
        const attr = (a: string) => el.getAttribute(a) ?? "";
        const txt = (el as HTMLElement).innerText ?? "";
        const name = (attr("aria-label") || attr("placeholder") || txt || attr("name") || attr("title") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        return {
          tag: el.tagName.toLowerCase(),
          type: attr("type"),
          role: attr("role"),
          name,
          value: String((el as HTMLInputElement).value ?? "").slice(0, 40),
        };
      });
    } catch {
      // element went stale between query and evaluate — keep a placeholder.
    }
    const meta = [info.type && `type=${info.type}`, info.role && `role=${info.role}`].filter(Boolean).join(" ");
    lines.push(`[${idx}] ${info.tag}${meta ? ` ${meta}` : ""}: ${info.name || "(no label)"}${info.value ? ` ="${info.value}"` : ""}`);
    if (handles.length >= 120) break;
  }
  let url = "";
  try {
    url = page.url();
  } catch {
    /* noop */
  }
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* noop */
  }
  let body = "";
  try {
    body = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{2,}/g, "\n").slice(0, 1500);
  } catch {
    /* noop */
  }
  const pdf = pdfBytes > 0 ? `yes (${pdfBytes} bytes)` : "none yet";
  const text = `URL: ${url}\nTITLE: ${title}\nPDF CAPTURED: ${pdf}\n\nINTERACTIVE ELEMENTS:\n${
    lines.join("\n") || "(none found)"
  }\n\nVISIBLE TEXT (truncated):\n${body}`;
  return { text, handles };
}

export async function runBrowserAgent(opts: RunBrowserAgentOpts): Promise<AgentOutcome> {
  const { page, goal, credentials, pdfBytes } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const model = opts.model ?? DEFAULT_MODEL;
  const log = opts.log ?? (() => {});
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  let { text, handles } = await snapshot(page, pdfBytes());
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `GOAL:\n${goal}\n\nCURRENT PAGE:\n${text}` },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      tools,
      tool_choice: { type: "any" },
      messages,
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      return { status: "error", detail: "model returned no tool call", steps: step };
    }
    messages.push({ role: "assistant", content: resp.content });
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    let result = "";

    try {
      switch (toolUse.name) {
        case "finish":
          if (pdfBytes() > 0) return { status: "success", detail: String(input.note ?? ""), steps: step };
          result = "No PDF captured yet — cannot finish. Keep going, or give_up.";
          break;
        case "give_up":
          return { status: "gave_up", detail: String(input.reason ?? ""), steps: step };
        case "goto":
          await page.goto(String(input.url), { waitUntil: "domcontentloaded", timeout: 30000 });
          result = "navigated";
          break;
        case "click": {
          const h = handles[Number(input.index)];
          if (!h) {
            result = "no element at that index — re-read the page list";
            break;
          }
          await h.click({ timeout: 10000 });
          await page.waitForTimeout(800);
          result = "clicked";
          break;
        }
        case "fill": {
          const h = handles[Number(input.index)];
          if (!h) {
            result = "no element at that index";
            break;
          }
          await h.fill(String(input.text), { timeout: 10000 });
          result = "filled";
          break;
        }
        case "fill_secret": {
          const h = handles[Number(input.index)];
          if (!h) {
            result = "no element at that index";
            break;
          }
          const val = input.which === "password" ? credentials.password : credentials.username;
          await h.fill(val, { timeout: 10000 });
          result = `filled ${String(input.which)} (value hidden)`;
          break;
        }
        case "press":
          await page.keyboard.press(String(input.key));
          await page.waitForTimeout(800);
          result = "pressed";
          break;
        default:
          result = `unknown tool ${toolUse.name}`;
      }
    } catch (err) {
      result = `action error: ${err instanceof Error ? err.message : String(err)}`;
    }

    log(`step ${step}: ${toolUse.name}(${JSON.stringify(input)}) → ${result}`);

    ({ text, handles } = await snapshot(page, pdfBytes()));
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: `${result}\n\nUPDATED PAGE:\n${text}` }],
    });
  }
  return { status: "max_steps", detail: `reached ${maxSteps} steps without capturing a PDF`, steps: maxSteps };
}
