// Network interceptor for the live-capture skill. Paste this whole block as the
// `text` of mcp__claude-in-chrome__javascript_tool (action: javascript_exec) on
// the target tab. It patches fetch + XHR to record API calls into window.__ccCap.
// Idempotent. Bodies capped at 4 KB; ring-buffered at 800 entries. Re-run after a
// full page reload. Read the buffer with: JSON.stringify(window.__ccCap)
(() => {
  if (window.__ccCap) return { already: true, count: window.__ccCap.length };
  const cap = (window.__ccCap = []);
  const MAX = 800, CAP = 4096;
  const clip = (s) => (typeof s === "string" ? s.slice(0, CAP) : null);
  const rec = (e) => { if (cap.length >= MAX) cap.shift(); cap.push(e); };
  const hObj = (h) => {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === "function") h.forEach((v, k) => (o[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
      else Object.assign(o, h);
    } catch {}
    return o;
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (typeof input === "object" && input && input.method) || "GET";
    const reqHeaders = hObj(init && init.headers);
    const reqBody = init && typeof init.body === "string" ? clip(init.body) : null;
    let res;
    try { res = await of.apply(this, arguments); }
    catch (err) { rec({ t: Date.now(), kind: "fetch", url, method, reqHeaders, reqBody, error: String(err) }); throw err; }
    let respHeaders = {}, respBody = null;
    try { respHeaders = hObj(res.headers); } catch {}
    try { const ct = (res.headers.get("content-type") || ""); if (/json|text|xml/i.test(ct)) respBody = clip(await res.clone().text()); } catch {}
    rec({ t: Date.now(), kind: "fetch", url, method, reqHeaders, reqBody, status: res.status, respHeaders, respBody });
    return res;
  };
  const OX = window.XMLHttpRequest;
  function WX() {
    const x = new OX();
    let _m = "GET", _u = "", _h = {};
    const oo = x.open; x.open = function (m, u) { _m = m; _u = u; return oo.apply(x, arguments); };
    const os = x.setRequestHeader; x.setRequestHeader = function (k, v) { _h[k] = v; return os.apply(x, arguments); };
    const osend = x.send; x.send = function (body) {
      x.addEventListener("loadend", () => {
        let rb = null;
        try { const ct = x.getResponseHeader("content-type") || ""; if (/json|text|xml/i.test(ct)) rb = clip(x.responseText); } catch {}
        rec({ t: Date.now(), kind: "xhr", url: _u, method: _m, reqHeaders: _h, reqBody: typeof body === "string" ? clip(body) : null, status: x.status, respBody: rb });
      });
      return osend.apply(x, arguments);
    };
    return x;
  }
  WX.prototype = OX.prototype;
  window.XMLHttpRequest = WX;
  return { installed: true };
})();
