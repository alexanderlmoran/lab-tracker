// Recipe engine — strategy implementations + registries. Each strategy is
// config-driven and reusable across portals. Secrets are referenced by ENV-VAR
// NAME in config (never the value) and read here.

import { request } from "undici";
import type {
  AuthState,
  DiscoveredRow,
  HttpAuthStrategy,
  HttpDiscoveryStrategy,
  HttpPdfStrategy,
} from "./types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`recipe: required env var ${name} is not set`);
  return v;
}

// Dig a dotted path ("order.orderNo") out of an object.
function dig(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function authHeaders(auth: AuthState, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (auth.cookieHeader) h.cookie = auth.cookieHeader;
  if (auth.bearer) h.authorization = `Bearer ${auth.bearer}`;
  return h;
}

// ---------------------------------------------------------------- auth

// Firebase email/password (optionally multi-tenant). cfg: {signinUrl, tenantId?,
// emailEnv, passwordEnv}. Returns {bearer: idToken}.
const firebaseAuth: HttpAuthStrategy = async (cfg) => {
  const body: Record<string, unknown> = {
    email: env(cfg.emailEnv as string),
    password: env(cfg.passwordEnv as string),
    returnSecureToken: true,
    clientType: "CLIENT_TYPE_WEB",
  };
  if (cfg.tenantId) body.tenantId = cfg.tenantId;
  const res = await request(cfg.signinUrl as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200) throw new Error(`firebase auth ${res.statusCode}: ${(await res.body.text()).slice(0, 160)}`);
  const json = (await res.body.json()) as { idToken?: string };
  if (!json.idToken) throw new Error("firebase auth returned no idToken");
  return { bearer: json.idToken };
};

// Classic ASP.NET forms login with a cookie jar + anti-forgery FORM token. cfg:
// {base, homePath, loginPath, accountEnv, passwordEnv, clientVersion, tokenPagePath,
//  loginFields:{account,password,clientVersion}}. Returns {cookieHeader, extra:{formToken}}.
const aspnetFormAuth: HttpAuthStrategy = async (cfg) => {
  const base = cfg.base as string;
  const jar = new Map<string, string>();
  const absorb = (sc: string | string[] | undefined) => {
    if (!sc) return;
    for (const c of Array.isArray(sc) ? sc : [sc]) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  const home = await request(`${base}${cfg.homePath ?? "/"}`, { method: "GET", headers: { accept: "text/html" } });
  absorb(home.headers["set-cookie"]);
  await home.body.dump();

  const f = (cfg.loginFields ?? {}) as Record<string, string>;
  const body = new URLSearchParams({
    [f.account ?? "LoginName"]: env(cfg.accountEnv as string),
    [f.password ?? "Password"]: env(cfg.passwordEnv as string),
    [f.clientVersion ?? "ClientVersion"]: String(cfg.clientVersion ?? ""),
  }).toString();
  const login = await request(`${base}${cfg.loginPath}`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded", origin: base, referer: `${base}/` },
    body,
  });
  absorb(login.headers["set-cookie"]);
  await login.body.dump();
  if (login.statusCode !== 302 && login.statusCode !== 200) throw new Error(`aspnet login ${login.statusCode}`);

  const tokenPage = await request(`${base}${cfg.tokenPagePath}`, {
    method: "GET",
    headers: { cookie: cookie(), accept: "text/html", referer: `${base}/` },
  });
  absorb(tokenPage.headers["set-cookie"]);
  const html = await tokenPage.body.text();
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  if (!m) throw new Error("aspnet: no anti-forgery token (login failed?)");
  return { cookieHeader: cookie(), extra: { formToken: m[1] } };
};

// Pre-captured session cookies from a Playwright storage.json (e.g. Genova). cfg:
// {sessionPathEnv, domainMatch}. Returns {cookieHeader}.
const sessionCookiesAuth: HttpAuthStrategy = async (cfg) => {
  const { readFile } = await import("node:fs/promises");
  const path = env(cfg.sessionPathEnv as string);
  const parsed = JSON.parse(await readFile(path, "utf-8")) as { cookies: { name: string; value: string; domain: string }[] };
  const re = new RegExp(cfg.domainMatch as string);
  const matching = parsed.cookies.filter((c) => re.test(c.domain));
  if (matching.length === 0) throw new Error(`session-cookies: no cookies matching ${cfg.domainMatch} in ${path}`);
  return { cookieHeader: matching.map((c) => `${c.name}=${c.value}`).join("; ") };
};

// ---------------------------------------------------------------- discovery

// Generic REST JSON list. cfg: {url, method?, body?, headers?, dataPath?, map:{...field paths}}.
const restJsonDiscovery: HttpDiscoveryStrategy = async (cfg, auth) => {
  const res = await request(cfg.url as string, {
    method: (cfg.method as string) ?? "GET",
    headers: authHeaders(auth, (cfg.headers as Record<string, string>) ?? {}),
    body: cfg.body ? (typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body)) : undefined,
  });
  if (res.statusCode !== 200) throw new Error(`rest-json ${res.statusCode}: ${(await res.body.text()).slice(0, 160)}`);
  const json = await res.body.json();
  const arr = (cfg.dataPath ? dig(json, cfg.dataPath as string) : json) as unknown[];
  return (Array.isArray(arr) ? arr : []).map((raw) => mapRow(raw, cfg.map as Record<string, string>));
};

// jQuery DataTables server-side (ASP.NET). cfg: {url, columns[], map, fromDays?, lengthN?,
// tokenFromExtra:"formToken"}. Sends the form token in the body.
const datatablesDiscovery: HttpDiscoveryStrategy = async (cfg, auth) => {
  const token = auth.extra?.[(cfg.tokenFromExtra as string) ?? "formToken"];
  if (!token) throw new Error("datatables: missing form token from auth");
  const cols = (cfg.columns as { data: string; searchable?: boolean }[]) ?? [];
  const parts: string[] = ["draw=1"];
  cols.forEach((c, i) => {
    const s = c.searchable === false ? "false" : "true";
    // The server binds on column `name`; placeholder (numeric) columns send empty.
    const name = /^\d+$/.test(c.data) ? "" : encodeURIComponent(c.data);
    parts.push(
      `columns%5B${i}%5D%5Bdata%5D=${encodeURIComponent(c.data)}`,
      `columns%5B${i}%5D%5Bname%5D=${name}`,
      `columns%5B${i}%5D%5Bsearchable%5D=${s}`,
      `columns%5B${i}%5D%5Borderable%5D=${s}`,
      `columns%5B${i}%5D%5Bsearch%5D%5Bvalue%5D=`,
      `columns%5B${i}%5D%5Bsearch%5D%5Bregex%5D=false`,
    );
  });
  const days = Number(cfg.fromDays ?? 730);
  const mdy = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  parts.push(
    "order%5B0%5D%5Bcolumn%5D=0",
    "order%5B0%5D%5Bdir%5D=desc",
    "start=0",
    `length=${Number(cfg.lengthN ?? 100)}`,
    "search%5Bvalue%5D=",
    "search%5Bregex%5D=false",
    `__RequestVerificationToken=${encodeURIComponent(token)}`,
    `from=${encodeURIComponent(mdy(new Date(Date.now() - days * 864e5)))}`,
    `to=${encodeURIComponent(mdy(new Date()))}`,
    "firstName=",
    "lastName=",
    `tblMain_length=${Number(cfg.lengthN ?? 100)}`,
  );
  const res = await request(cfg.url as string, {
    method: "POST",
    headers: authHeaders(auth, {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      ...((cfg.headers as Record<string, string>) ?? {}),
    }),
    body: parts.join("&"),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200 || !text.trim()) {
    throw new Error(`datatables ${res.statusCode} (token/session expired or empty body, len=${text.length})`);
  }
  const json = JSON.parse(text) as { data?: unknown[] };
  return (json.data ?? []).map((raw) => mapRow(raw, cfg.map as Record<string, string>));
};

function mapRow(raw: unknown, map: Record<string, string>): DiscoveredRow {
  return {
    ref: str(dig(raw, map.ref)),
    name: str(dig(raw, map.name)),
    dob: str(dig(raw, map.dob)),
    status: str(dig(raw, map.status)),
    pdfRef: str(dig(raw, map.pdfRef)),
    resultIssuedAt: str(dig(raw, map.resultIssuedAt))?.slice(0, 10),
    raw,
  };
}

// ---------------------------------------------------------------- pdf

// Build the fetch URL from a template, substituting {pdfRef}, {ref}, {base}.
function pdfUrl(cfg: Record<string, unknown>, row: DiscoveredRow): string {
  const tpl = cfg.urlTemplate as string;
  const url = tpl
    .replace("{pdfRef}", encodeURIComponent(row.pdfRef ?? ""))
    .replace("{pdfRefRaw}", row.pdfRef ?? "")
    .replace("{ref}", encodeURIComponent(row.ref ?? ""))
    .replace("{base}", (cfg.base as string) ?? "");
  return url;
}

// Simple authenticated GET that returns a PDF.
const httpGetPdf: HttpPdfStrategy = async (cfg, auth, row) => {
  const res = await request(pdfUrl(cfg, row), {
    method: "GET",
    headers: authHeaders(auth, (cfg.headers as Record<string, string>) ?? {}),
  });
  if (res.statusCode !== 200) {
    await res.body.dump();
    throw new Error(`http-get pdf ${res.statusCode}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("http-get: response was not a PDF");
  return buf;
};

// GET that streams progress JSON then the PDF (GlycanAge); slice from %PDF-.
const httpGetStreamSlicePdf: HttpPdfStrategy = async (cfg, auth, row) => {
  const res = await request(pdfUrl(cfg, row), {
    method: "GET",
    headers: authHeaders(auth, (cfg.headers as Record<string, string>) ?? {}),
  });
  if (res.statusCode !== 200) {
    await res.body.dump();
    throw new Error(`http-get-stream-slice pdf ${res.statusCode}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  const at = buf.indexOf("%PDF-");
  if (at < 0) throw new Error(`stream-slice: no PDF in response (${buf.subarray(0, 50).toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim()})`);
  return buf.subarray(at);
};

// ---------------------------------------------------------------- registries

export const AUTH_STRATEGIES: Record<string, HttpAuthStrategy> = {
  firebase: firebaseAuth,
  "aspnet-form": aspnetFormAuth,
  "session-cookies": sessionCookiesAuth,
};

export const DISCOVERY_STRATEGIES: Record<string, HttpDiscoveryStrategy> = {
  "rest-json": restJsonDiscovery,
  datatables: datatablesDiscovery,
};

export const PDF_STRATEGIES: Record<string, HttpPdfStrategy> = {
  "http-get": httpGetPdf,
  "http-get-stream-slice": httpGetStreamSlicePdf,
};
