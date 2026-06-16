---
name: live-capture
description: Capture a site's API endpoints + request/response SCHEMAS from your LIVE logged-in Chrome (via Claude-in-Chrome), into a PHI-safe corpus for building future portal scrapers — no separate Playwright login or MFA/CAPTCHA dance. Use when the user wants to "capture this portal", "log the API calls a site makes", "reverse-engineer <site>'s API from my browser", "add <portal> to the API map", "figure out how <site> creates/saves X", or passively record requests while browsing an authenticated site. Pairs with lab-portal-capture (that one uses a separate Playwright Chromium + full HAR; THIS one uses the user's real session and stores PHI-safe schemas).
---

# Live portal capture (Claude-in-Chrome)

Reverse-engineer a portal's API by recording the calls it makes **in the user's own
authenticated Chrome tab**, then distilling them into a PHI-safe API map you can
build a scraper from. The win over `lab-portal-capture`: no separate Playwright
login — you ride the session the user is already in (MFA/CAPTCHA already passed).

## Honest limits — say these if the user expects "always-on logging"
- **Not a background daemon.** Capture only happens while a Claude session has the
  interceptor injected in a tab. There is no process silently logging every site
  24/7. The model is: inject → user browses the portal → harvest. Re-inject per
  portal/session; each harvest **appends** to the corpus, so it accumulates over time.
- **Per-tab, resets on full navigation.** The interceptor lives in the page; a full
  page load / domain change drops it (re-inject). SPA hash-route changes keep it.
- **PHI/credentials.** These are healthcare portals. The harvest step **masks secret
  header values and reduces bodies to schemas** (field names + types + a redacted
  sample) — raw bodies and tokens are never written to the corpus. The corpus lives
  under `worker/captures/` which is gitignored.

## Workflow

1. **Pick the tab.** `mcp__claude-in-chrome__tabs_context_mcp` → find the portal tab
   the user is logged into (or `tabs_create_mcp` + navigate, sharing the session).
   Reuse the user's tab only when they asked you to work with that site.

2. **Inject the interceptor** with `mcp__claude-in-chrome__javascript_tool` (paste
   the block in `scripts/interceptor.js`). It monkey-patches `fetch` + `XMLHttpRequest`
   to record `{url, method, reqHeaders, reqBody, status, respHeaders, respBody}` into
   `window.__ccCap` (bodies capped at 4 KB; max 800 entries). Idempotent — returns
   `{already:true}` if present. Re-inject after any full page reload.

3. **Let the user drive.** Tell them to perform the flow you want to capture (log in,
   open the form, **create/save the record**, open a report, etc.). You do NOT perform
   account creation, sends, payments, or other side-effectful/irreversible actions —
   the user does those; you only observe. Optionally also call
   `mcp__claude-in-chrome__read_network_requests` for the extension's own request list
   (URLs/methods/status) as a cross-check — but it may omit bodies, which is why the
   interceptor exists.

4. **Harvest.** Read the buffer and write it to a temp file, then distill:
   ```
   # in javascript_tool: JSON.stringify(window.__ccCap)
   ```
   Save that JSON to `$TMPDIR/cc-capture.json`, then run from the repo root:
   ```
   node .claude/skills/live-capture/scripts/harvest.mjs "$TMPDIR/cc-capture.json" worker/captures/live-api-map
   ```
   It merges into `worker/captures/live-api-map/<host>.json` — per-endpoint header
   names (secrets masked), request/response schemas, statuses, query keys, counts.
   Clear the buffer between flows with `window.__ccCap.length = 0` (javascript_tool).

5. **Use the corpus.** To build a scraper for an endpoint, read the host file and you
   have the method, path, required headers, and payload/response shape. Real auth
   values come from the worker's existing session handling (practicebetter.ts /
   fetch-browser.ts) — the corpus is the map, not the keys.

## Notes
- Reuse the worker's egress patterns when turning a captured endpoint into code
  (`pbRequest` for PB, the cookie transport in `fetch-browser.ts` for Zenoti). See
  `docs/PLAYBOOK.md`.
- If a captured call is the only example of an endpoint and you need a real sample
  value (not a schema) to proceed, inspect it in-session via `javascript_tool`
  (`window.__ccCap`) — don't persist it.
- One distinct endpoint can have several body shapes; the corpus keeps the first of
  each field it sees and unions header names across calls.
