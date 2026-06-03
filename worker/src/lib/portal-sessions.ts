// Portal session bootstrap for hosted (Fly) runs.
//
// Some scrapers reuse a Playwright `storage.json` (cookies) captured via a
// manual, gated login (Zenoti ~24h cookies; Genova reCAPTCHA+MFA). Locally the
// file lives under worker/captures/...; on Fly there is no such file, so we
// instead carry the session as a base64 secret and materialize it to a temp
// file at startup, exposing the path the scraper already reads.
//
// Refresh workflow when a session expires: re-capture the storage.json locally,
// then `fly secrets set <PORTAL>_SESSION_B64="$(base64 -i path/to/storage.json)"`.
// Updating the secret restarts the machines, which re-materialize on next run.
//
// Local dev is unaffected: the *_SESSION_B64 secrets aren't set, so nothing is
// materialized and the scrapers fall back to their local file paths.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type SessionSpec = { b64Env: string; pathEnv: string; file: string };

const SESSIONS: SessionSpec[] = [
  { b64Env: "ZENOTI_SESSION_B64", pathEnv: "ZENOTI_STORAGE_PATH", file: "zenoti-storage.json" },
  { b64Env: "GENOVA_SESSION_B64", pathEnv: "GENOVA_SESSION_PATH", file: "genova-storage.json" },
];

let done = false;

/** Decode any *_SESSION_B64 secrets to temp files and point the matching
 * *_SESSION_PATH env at them. Idempotent; never throws (a bad/absent secret
 * just leaves the scraper to report its own "session not configured" error).
 * An explicitly-set path env wins (so local dev / overrides are respected). */
export function materializePortalSessions(): void {
  if (done) return;
  done = true;
  const dir = join(tmpdir(), "portal-sessions");
  for (const s of SESSIONS) {
    const b64 = process.env[s.b64Env];
    if (!b64 || process.env[s.pathEnv]) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, s.file);
      writeFileSync(path, Buffer.from(b64, "base64"));
      process.env[s.pathEnv] = path;
    } catch {
      // best-effort
    }
  }
}
