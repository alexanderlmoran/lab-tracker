// Tiny zero-dep loader for the tracker's `.env.local`.
//
// Worker scripts don't run under Next.js, so Next's automatic env loading
// doesn't apply. Rather than adding `dotenv` as a dep, we parse `.env.local`
// ourselves with the small subset of dotenv syntax we actually need:
//   - `KEY=value`
//   - `KEY='value with spaces'` and `KEY="value"`
//   - lines starting with `#` are comments
//   - blank lines ignored
//   - existing process.env values win (so explicit overrides on the CLI
//     still take precedence, e.g. `PB_PASSWORD=other npx tsx ...`)
//
// Call once at the top of any worker script before reading process.env.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILENAME = ".env.local";

function findEnvFile(): string | null {
  // Resolve relative to this source file, then walk up looking for the file.
  // Worker scripts run from worker/scripts/, so .env.local is at ../../
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = resolve(here);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ENV_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip surrounding quotes (single or double) if balanced.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

let loaded = false;

/** Loads .env.local into process.env. Idempotent — safe to call repeatedly. */
export function loadEnvLocal(): void {
  if (loaded) return;
  loaded = true;
  const path = findEnvFile();
  if (!path) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [k, v] = parsed;
    // Don't clobber explicit CLI overrides.
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
