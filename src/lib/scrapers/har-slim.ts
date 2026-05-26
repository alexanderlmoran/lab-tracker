import "server-only";

// HAR slimmer.
//
// Captured HAR files from real portal sessions are typically 30-60 MB —
// far too large to send to Claude. We aggressively trim them down to ~50-
// 150 KB while preserving everything an LLM needs to write a scraper:
//
//   - Request method, URL, headers (cookie/auth/csrf preserved; bulk
//     trace headers like sec-* dropped)
//   - Request body (forms, JSON payloads)
//   - Response status + headers
//   - First N chars of each response body as a hint (so Claude can see
//     "ah, this endpoint returns a JSON list of patients")
//   - Stripped of static-asset and CDN noise
//
// The slim shape is a small JSON object the LLM can ingest cleanly.

export type SlimHarEntry = {
  startedDateTime: string;
  method: string;
  url: string;
  /** Domain of the URL — useful for the model to group by origin. */
  origin: string;
  /** Pathname only — used for pattern recognition. */
  pathname: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  status: number;
  statusText: string;
  respHeaders: Record<string, string>;
  respMime: string | null;
  respSize: number;
  /** First N chars of the response body, stripped of obvious binary. */
  respBodySample: string | null;
};

export type SlimHar = {
  entryCount: number;
  // After-trim count. Useful for debugging "did we drop too much?".
  keptCount: number;
  entries: SlimHarEntry[];
};

const SKIP_EXTENSIONS = [
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".css", ".map",
  ".mp4", ".webm",
];

const SKIP_HOST_SUBSTRINGS = [
  "google-analytics", "googletagmanager", "doubleclick",
  "facebook.com", "fbcdn.net", "segment.io", "fullstory.com",
  "hotjar.com", "intercom.io", "sentry.io", "datadoghq.com",
  "cloudflareinsights", "cdn.jsdelivr.net", "fonts.googleapis",
  "fonts.gstatic", "unpkg.com",
];

// Request headers we always drop — they bloat without telling Claude
// anything useful. Custom x-* headers and auth/cookie/csrf stay.
const DROP_REQ_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language",
  "user-agent", "referer", "origin",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
  "upgrade-insecure-requests", "priority", "te",
  "connection", "host", "pragma", "cache-control",
]);

const DROP_RESP_HEADERS = new Set([
  "alt-svc", "report-to", "nel", "server-timing", "x-served-by",
  "vary", "via", "x-cache", "x-cache-hits",
  "strict-transport-security", "x-content-type-options",
  "x-frame-options", "x-xss-protection", "referrer-policy",
  "permissions-policy", "content-security-policy",
  "cf-ray", "cf-cache-status", "x-amz-cf-id", "x-amz-cf-pop",
]);

const RESP_BODY_SAMPLE_CHARS = 800;
const MAX_KEPT_ENTRIES = 80;

function flattenHarHeaders(
  headers: Array<{ name: string; value: string }> | undefined,
  drop: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    if (drop.has(name)) continue;
    // Cookie values can be huge — keep the names but truncate values
    // to first 40 chars (enough for the model to see "yes there's a
    // session cookie" without leaking it).
    if (name === "cookie" || name === "set-cookie") {
      const cookies = h.value.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
      out[name] = cookies.join("; ") + " (values truncated)";
      continue;
    }
    out[name] = h.value.length > 200 ? `${h.value.slice(0, 200)}…` : h.value;
  }
  return out;
}

function looksLikeBinary(s: string): boolean {
  // Cheap heuristic: lots of replacement chars or zero bytes → binary.
  if (s.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < Math.min(s.length, 200); i++) {
    const code = s.charCodeAt(i);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13))
      nonPrintable++;
  }
  return nonPrintable / Math.min(s.length, 200) > 0.1;
}

function shouldKeepEntry(url: string, mime: string | null): boolean {
  try {
    const u = new URL(url);
    const lowerPath = u.pathname.toLowerCase();
    for (const ext of SKIP_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) return false;
    }
    for (const host of SKIP_HOST_SUBSTRINGS) {
      if (u.host.includes(host)) return false;
    }
  } catch {
    // bad URL — keep it; the LLM might still find it informative
    return true;
  }
  if (mime) {
    const m = mime.toLowerCase();
    if (m.startsWith("image/") || m.startsWith("font/") || m.startsWith("video/")) {
      return false;
    }
  }
  return true;
}

// Minimal HAR types — we only touch the fields we care about.
type HarFile = { log: { entries: HarEntry[] } };
type HarEntry = {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { text?: string; mimeType?: string };
  };
  response: {
    status: number;
    statusText: string;
    headers?: Array<{ name: string; value: string }>;
    content?: { mimeType?: string; size?: number; text?: string };
  };
};

export function slimHar(rawHarJson: string): SlimHar {
  const har: HarFile = JSON.parse(rawHarJson);
  const entries = har.log?.entries ?? [];
  const slim: SlimHarEntry[] = [];

  for (const e of entries) {
    const url = e.request.url;
    const mime = e.response.content?.mimeType ?? null;
    if (!shouldKeepEntry(url, mime)) continue;

    let pathname = "";
    let origin = "";
    try {
      const u = new URL(url);
      pathname = u.pathname + u.search;
      origin = u.origin;
    } catch {
      pathname = url;
    }

    let respBodySample: string | null = null;
    const respText = e.response.content?.text ?? null;
    if (respText && !looksLikeBinary(respText)) {
      respBodySample =
        respText.length > RESP_BODY_SAMPLE_CHARS
          ? `${respText.slice(0, RESP_BODY_SAMPLE_CHARS)}…[${respText.length - RESP_BODY_SAMPLE_CHARS} more chars]`
          : respText;
    }

    slim.push({
      startedDateTime: e.startedDateTime,
      method: e.request.method,
      url,
      origin,
      pathname,
      reqHeaders: flattenHarHeaders(e.request.headers, DROP_REQ_HEADERS),
      reqBody: e.request.postData?.text ?? null,
      status: e.response.status,
      statusText: e.response.statusText,
      respHeaders: flattenHarHeaders(e.response.headers, DROP_RESP_HEADERS),
      respMime: mime,
      respSize: e.response.content?.size ?? 0,
      respBodySample,
    });
  }

  // If still too many entries, keep a representative sample: every Nth
  // entry, biasing toward later ones (the meat of a session is usually
  // the result-download requests at the end).
  let kept = slim;
  if (slim.length > MAX_KEPT_ENTRIES) {
    const stride = Math.ceil(slim.length / MAX_KEPT_ENTRIES);
    kept = slim.filter((_, i) => i % stride === 0).slice(-MAX_KEPT_ENTRIES);
  }

  return { entryCount: entries.length, keptCount: kept.length, entries: kept };
}
