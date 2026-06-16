// Distill the captured buffer (window.__ccCap, from interceptor.js) into a
// PHI/auth-free API map — run this IN the page via mcp__claude-in-chrome__javascript_tool.
// It reduces every call to: METHOD /path → header NAMES (secrets flagged), body
// SCHEMAS (field name + type only — NO string values, NO query strings). Only this
// clean map crosses the MCP boundary (raw buffers get blocked because they carry
// cookies/tokens). Return value → save to a temp .json → `node harvest.mjs <file>`.
(() => {
  const cap = window.__ccCap || [];
  const SENS = /(pass|token|secret|ssn|social|dob|birth|email|phone|mobile|firstname|lastname|fullname|fname|lname|name|address|street|zip|postal|guardian|emergency|city|state|gender|authorizeduserid|code|account|card|cvv|routing)/i;
  const SECRET_H = /^(authorization|cookie|set-cookie|x-xsrf-token|x-csrf-token|x-api-key|api-key|x-session-id|x-auth-token|x-access-token|x-authorizationtoken|__requestverificationtoken|newrelic|traceparent|tracestate|x-newrelic-id)$/i;
  const shape = (v, key, d = 0) => {
    if (d > 6) return "…";
    if (v === null) return "null";
    if (Array.isArray(v)) return v.length ? [shape(v[0], key, d + 1)] : [];
    if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 60)) o[k] = shape(v[k], k, d + 1); return o; }
    const t = typeof v;
    return t === "string" ? (SENS.test(key) ? "string(redacted)" : "string") : t;
  };
  const bshape = (b) => { if (b == null) return null; try { return shape(JSON.parse(b), ""); } catch { return "non-json"; } };
  const skip = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|js|map|ico|mp4|m4s)(\?|$)/i;
  const noise = /jserrors|newrelic|nr-data|google-?anal|googletag|linkedin|amplitude|datadog|awswaf|telemetrywebhooks|doubleclick|facebook/i;
  const map = {};
  for (const e of cap) {
    if (!e.url || skip.test(e.url) || !(e.kind === "fetch" || e.kind === "xhr")) continue;
    let host, path; try { const x = new URL(e.url); host = x.host; path = x.pathname; } catch { continue; }
    if (noise.test(host + path)) continue;
    const key = (e.method || "GET").toUpperCase() + " " + path;
    (map[host] ??= {});
    const ep = (map[host][key] ??= { method: (e.method || "GET").toUpperCase(), path, count: 0, statuses: [], reqHeaderNames: [], reqSchema: null, respSchema: null });
    ep.count++;
    if (e.status != null && !ep.statuses.includes(e.status)) ep.statuses.push(e.status);
    for (const h of Object.keys(e.reqHeaders || {})) { const nm = SECRET_H.test(h) ? h + "(secret)" : h; if (!ep.reqHeaderNames.includes(nm)) ep.reqHeaderNames.push(nm); }
    if (!ep.reqSchema) { const s = bshape(e.reqBody); if (s) ep.reqSchema = s; }
    if (!ep.respSchema) { const s = bshape(e.respBody); if (s) ep.respSchema = s; }
  }
  return { hosts: Object.keys(map), endpointCounts: Object.fromEntries(Object.keys(map).map((h) => [h, Object.keys(map[h]).length])), map };
})();
