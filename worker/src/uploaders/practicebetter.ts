// PracticeBetter PDF uploader.
//
// PB exposes a clean 4-step API for attaching a PDF to a patient's labrequest.
// We do NOT use Playwright here — the entire flow is plain HTTP via undici.
// Discovered 2026-05-21 via Playwright codegen + HAR capture (see
// worker/captures/practicebetter/20260521-200218/).
//
// Flow:
//   1. POST /api/oauth2/token            → cookie-based session
//   2. GET  /api/consultant/records/...  → resolve patient by name (+DOB tiebreak)
//   3. POST /api/batch?context=uploadTokens → S3 pre-signed PUT URL + fileToken
//   4. PUT  <s3 url>                     → upload PDF binary; read x-amz-version-id
//   5. POST /api/consultant/labrequests  → create labrequest referencing the upload
//
// Auth: PB uses session cookies after OAuth password grant. We capture the
// Set-Cookie headers from step 1 and re-send them on subsequent requests.

import { readFile } from "node:fs/promises";
import { request, ProxyAgent, type Dispatcher } from "undici";

export const PB_BASE = "https://my.practicebetter.io";
// This client_id is the public web client; identical for all PB tenants. Pulled
// from the OAuth call in the capture HAR — not secret.
const PB_CLIENT_ID = "099153c2625149bc8ecb3e85e03f0022";

// PB blocks datacenter IPs (OAuth token endpoint returns error 8000) — confirmed
// from BOTH Fly and Vercel; only residential IPs authenticate. When PB_PROXY_URL
// is set, route every PB-DOMAIN call through it (a residential exit). The S3 PUT
// is NOT proxied — pre-signed URLs aren't IP-restricted, and a large PDF body
// shouldn't pay residential-proxy latency. If PB_PROXY_URL is unset, behavior is
// unchanged (direct egress), so this is a no-op outside Fly/Vercel.
const pbDispatcher: Dispatcher | undefined = process.env.PB_PROXY_URL
  ? new ProxyAgent(process.env.PB_PROXY_URL)
  : undefined;

/** Like undici `request`, but routes PB-domain traffic through the residential
 *  proxy when PB_PROXY_URL is configured. Use for every my.practicebetter.io
 *  call; use bare `request` for S3. */
export function pbRequest(
  url: Parameters<typeof request>[0],
  opts: Parameters<typeof request>[1] = {},
): ReturnType<typeof request> {
  return request(url, pbDispatcher ? { ...opts, dispatcher: pbDispatcher } : opts);
}

// ── Types ────────────────────────────────────────────────────────────

/** Thrown when PB rejects an authenticated call with 401/403 — i.e. the cached
 *  session has expired. Callers can `instanceof PbAuthError` to know a re-login
 *  is needed (vs. a transient network error), mirroring the drain path's
 *  authError signal. `withPbReauth` self-heals these for one re-login + retry. */
export class PbAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PbAuthError";
    this.statusCode = statusCode;
  }
}

/** True for any error that means "PB session expired" — a typed PbAuthError, or
 *  a legacy string-message error that mentions 401/403/unauthorized/forbidden. */
export function isPbAuthError(e: unknown): boolean {
  if (e instanceof PbAuthError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(401|403)\b|unauthor|forbidden/i.test(msg);
}

/** A PB session plus the means to mint a fresh one. Pass this (instead of a bare
 *  PbSession) to `withPbReauth` so a mid-run 401 self-heals: invalidate the stale
 *  session, re-login ONCE, retry the call once. `session` is mutable so the
 *  refreshed cookies propagate back to the caller (the loop reuses them). */
export type PbSessionProvider = {
  session: PbSession;
  relogin: () => Promise<PbSession>;
};

/** Build a self-healing provider around credentials. The first `session` is the
 *  one passed in (already logged in); `relogin()` mints a fresh session AND
 *  updates `provider.session` in place so subsequent calls reuse it. */
export function pbSessionProvider(
  session: PbSession,
  username: string,
  password: string,
): PbSessionProvider {
  const provider: PbSessionProvider = {
    session,
    relogin: async () => {
      provider.session = await pbLogin(username, password);
      return provider.session;
    },
  };
  return provider;
}

/** Run an authenticated PB call with one-shot 401/403 self-heal: invoke `fn`
 *  with the current session; if it throws a PB auth error, drop the cached
 *  session, re-login ONCE, and retry `fn` once. A second auth failure throws a
 *  clear PbAuthError (credentials/blocked, not just a stale cookie). This is the
 *  drain path's drop-on-authError behavior, centralized so the IV reconcile +
 *  PC-seed paths (which reuse a cached session) stop wedging on an expired one. */
export async function withPbReauth<T>(
  provider: PbSessionProvider,
  fn: (session: PbSession) => Promise<T>,
): Promise<T> {
  try {
    return await fn(provider.session);
  } catch (e) {
    if (!isPbAuthError(e)) throw e;
    // Stale session → invalidate, re-login once, retry once.
    const fresh = await provider.relogin();
    try {
      return await fn(fresh);
    } catch (e2) {
      if (isPbAuthError(e2)) {
        throw new PbAuthError(
          `PB re-auth failed after one retry (credentials invalid or IP blocked): ${
            e2 instanceof Error ? e2.message : String(e2)
          }`,
          e2 instanceof PbAuthError ? e2.statusCode : 401,
        );
      }
      throw e2;
    }
  }
}

export type PbSession = {
  cookies: string;
  userId: string;
  sessionId: string;
  companyId: string;
  /** URL-decoded value of the bcm_csrf cookie. Resent as x-xsrf-token header
   * on every authenticated POST — PB uses double-submit-cookie CSRF. */
  csrfToken: string;
};

export type PbPatient = {
  id: string;
  firstName: string;
  lastName: string;
  dayOfBirth: string | null;
  emailAddress: string | null;
  /** homePhone from the records/search profile (used for IV match grading). */
  phone?: string | null;
};

export type UploadInput = {
  username: string;
  password: string;
  /** PB user ID of the consultant the lab is assigned to. Read from
   * /api/company/administration/members?practitioner=true once and cache. */
  consultantId: string;
  patientName: string;
  /** YYYY-MM-DD used to disambiguate when the patient name search returns
   * multiple matches. Optional but strongly recommended. */
  patientDob?: string;
  /** Patient email — the EMAIL fallback for findPbPatient when PB's name is
   * typo'd (PB "Micheal" vs case "Michael"); matched exactly so it's safe. */
  patientEmail?: string;
  labName: string;
  /** ISO timestamp for dateOrdered. Use the lab's collection date if known. */
  dateOrdered: string;
  pdfPath: string;
  pdfFilename: string;
  /** Whether the patient sees this lab in their client portal. Default false. */
  isClientFacing?: boolean;
  /** Whether PB sends the patient a notification email on creation. Default true. */
  notify?: boolean;
  /** Safety guardrail. If set, the upload ABORTS (before any write) unless the
   * resolved PB patient id equals this. Used by the Settings post-test so it can
   * only ever land on the nominated test patient — never anyone else. */
  expectedPatientId?: string;
};

export type UploadResult = {
  labRequestId: string;
  patientId: string;
  /** True when no PB chart existed and this post created one. */
  createdPatient?: boolean;
};

// ── Cookie handling ──────────────────────────────────────────────────

function parseSetCookies(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookiesAsHeader(setCookies: string[]): string {
  // Strip Path/Expires/etc. — keep only `name=value` for the Cookie header.
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function findCookieValue(setCookies: string[], name: string): string | null {
  for (const sc of setCookies) {
    const first = sc.split(";")[0].trim();
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    if (first.slice(0, eq) === name) return first.slice(eq + 1);
  }
  return null;
}

/** Headers PB requires on every authenticated API call (in addition to
 * cookies). Reconstructed from the capture HAR. */
export function pbApiHeaders(session: PbSession): Record<string, string> {
  return {
    cookie: session.cookies,
    "x-xsrf-token": session.csrfToken,
    "x-company-id": session.companyId,
    "x-session-id": session.sessionId,
    "x-platform": "web",
    "x-timezone": "America/New_York,en-us",
  };
}

// ── Login ────────────────────────────────────────────────────────────

export async function pbLogin(
  username: string,
  password: string,
): Promise<PbSession> {
  const body = new URLSearchParams({
    username,
    password,
    grant_type: "password",
    remember_me: "false",
    verification_code: "",
    client_id: PB_CLIENT_ID,
  });
  const res = await pbRequest(`${PB_BASE}/api/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`PB login failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as {
    id: string;
    sessionId: string;
    companyId: string;
  };
  const setCookies = parseSetCookies(
    res.headers as Record<string, string | string[] | undefined>,
  );
  if (setCookies.length === 0) {
    throw new Error("PB login returned 200 but no Set-Cookie headers");
  }
  const csrfRaw = findCookieValue(setCookies, "bcm_csrf");
  if (!csrfRaw) {
    throw new Error("PB login response missing bcm_csrf cookie");
  }
  return {
    cookies: cookiesAsHeader(setCookies),
    userId: json.id,
    sessionId: json.sessionId,
    companyId: json.companyId,
    // bcm_csrf is URL-encoded in the cookie; the matching x-xsrf-token header
    // sends the decoded value.
    csrfToken: decodeURIComponent(csrfRaw),
  };
}

// ── Patient search ───────────────────────────────────────────────────

export async function findPbPatient(
  session: PbSession,
  patientName: string,
  dob?: string,
  email?: string,
): Promise<PbPatient | null> {
  type PbHit = { id: string; profile: { firstName: string; lastName: string; dayOfBirth?: string; emailAddress?: string } };
  // PB's search expects + for spaces (literal +, not %20). Normalize "Last,
  // First" / "First Last" to a plain space-separated string then re-encode.
  const search = async (q: string): Promise<PbHit[]> => {
    const query = encodeURIComponent(q.replace(/,/g, " ").replace(/\s+/g, " ").trim()).replace(/%20/g, "+");
    const res = await pbRequest(`${PB_BASE}/api/consultant/records/search?countlimit=8&limit=8&query=${query}`, {
      method: "GET",
      headers: pbApiHeaders(session),
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.text().catch(() => {});
      throw new PbAuthError(`PB patient search failed ${res.statusCode}`, res.statusCode);
    }
    if (res.statusCode !== 200) throw new Error(`PB patient search failed ${res.statusCode}`);
    return ((await res.body.json()) as { items: PbHit[] }).items;
  };

  let items = await search(patientName);

  // Name search missed → fall back to EMAIL. This catches PB name typos (PB
  // "Micheal Holland" vs the case's "Michael Holland") where the @email still
  // matches. BUT email is NOT a unique patient key: families share one address
  // (Avva 2019 + Leo Stimler 2016 both use yanatara@me.com). So an exact-email
  // hit ALSO needs a NAME guard — last name + first initial — or a child's lab
  // result posts to a parent/sibling chart (this is exactly how Avva's result
  // cross-matched a relative). The first-initial check keeps the typo case
  // (Micheal/Michael share "m") while blocking the sibling swap (Avva vs Leo).
  if (items.length === 0 && email) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const comma = patientName.includes(",");
    const toks = comma ? patientName.split(",").map((s) => s.trim()) : patientName.trim().split(/\s+/);
    const pFirst = norm(comma ? toks[1] ?? "" : toks[0] ?? "");
    const pLast = norm(comma ? toks[0] ?? "" : toks[toks.length - 1] ?? "");
    const byEmail = await search(email);
    items = byEmail.filter((it) => {
      if ((it.profile.emailAddress ?? "").toLowerCase() !== email.toLowerCase()) return false;
      const last = norm(it.profile.lastName ?? "");
      const first = norm(it.profile.firstName ?? "");
      if (!pLast || pLast !== last) return false;
      return !pFirst || !first || pFirst === first || pFirst[0] === first[0];
    });
  }
  if (items.length === 0) return null;

  let candidates = items;
  if (dob) {
    const dobMatches = candidates.filter((it) =>
      (it.profile.dayOfBirth ?? "").startsWith(dob),
    );
    if (dobMatches.length > 0) {
      candidates = dobMatches;
    } else if (candidates.length > 1) {
      // DOB was given but matched NONE of several same-name hits → genuinely
      // ambiguous. Returning candidates[0] here would post a lab to a GUESSED
      // wrong chart. Refuse — the caller holds for a human (patient safety).
      // (A single fuzzy hit with a mismatched DOB is still returned: likely a PB
      // DOB typo, e.g. "Micheal" vs "Michael", not a different person.)
      return null;
    }
  } else if (candidates.length > 1) {
    // No DOB to disambiguate several same-name charts — returning the first is
    // exactly the wrong-patient hazard (Avva Stimler had no DOB on file). Refuse
    // and let the caller hold for a human / backfill the DOB. A single hit is
    // still returned (no ambiguity to resolve).
    return null;
  }
  const m = candidates[0];
  return {
    id: m.id,
    firstName: m.profile.firstName,
    lastName: m.profile.lastName,
    dayOfBirth: m.profile.dayOfBirth ?? null,
    emailAddress: m.profile.emailAddress ?? null,
  };
}

/** Create a new PB client record from a patient's identity — for when a result
 *  has no matching PB account (the "Maverick" case: the post otherwise fails
 *  silently). Reverse-engineered live from PB's "Add a client" flow
 *  (POST /api/consultant/records); uses the SAME write headers as labrequests/
 *  sessionnotes. Returns the new PbPatient (its `id` is the clientRecordId to
 *  post to). See the live-capture corpus / docs/PLAYBOOK.md "PB create client".
 *
 *  `sendInvitation` defaults to TRUE (Alex 2026-06-16): PB's invitation email IS
 *  the patient's first portal login, so every created patient gets invited — same
 *  rationale as the labrequest notify flag. Pass false to suppress.
 *
 *  DOB formats mirror PB exactly (captured): dayOfBirth "YYYY-MM-DD", dateOfBirth
 *  ISO "YYYY-MM-DDT00:00:00.000Z". Both omitted when no DOB is known. The journal/
 *  lifestyle flags replicate PB's UI new-client defaults so the record looks
 *  UI-created. */
export async function createPbPatient(
  session: PbSession,
  input: { firstName: string; lastName: string; email: string; dob?: string | null },
  opts: { sendInvitation?: boolean } = {},
): Promise<PbPatient> {
  const firstName = (input.firstName ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  const email = (input.email ?? "").trim();
  if (!firstName || !lastName || !email) {
    throw new Error("createPbPatient requires firstName, lastName, and email");
  }
  const dob = (input.dob ?? "").trim().slice(0, 10); // YYYY-MM-DD
  const profile: Record<string, unknown> = { firstName, lastName, emailAddress: email };
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    profile.dayOfBirth = dob;
    profile.dateOfBirth = `${dob}T00:00:00.000Z`;
  }
  const body = {
    profile,
    isActive: true,
    sendInvitation: opts.sendInvitation ?? true,
    documentsFolder: true,
    enableJournal: false,
    foodMoodJournal: false,
    lifestyleJournal: false,
    foodJournalOptions: { enableFood: true, enableWater: true },
    lifestyleJournalOptions: {
      enableActivity: true,
      enableBowel: true,
      enableMeasurements: true,
      enableMood: true,
      enableSleep: true,
      importSettings: { importMeasurements: true },
    },
    additionalDetails: [],
  };
  const res = await pbRequest(`${PB_BASE}/api/consultant/records`, {
    method: "POST",
    headers: { ...pbApiHeaders(session), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    const text = await res.body.text();
    throw new Error(`PB create patient failed ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  const rec = (await res.body.json()) as {
    id: string;
    profile?: { firstName?: string; lastName?: string; dayOfBirth?: string; emailAddress?: string };
  };
  return {
    id: rec.id,
    firstName: rec.profile?.firstName ?? firstName,
    lastName: rec.profile?.lastName ?? lastName,
    dayOfBirth: rec.profile?.dayOfBirth ?? (profile.dayOfBirth as string | undefined) ?? null,
    emailAddress: rec.profile?.emailAddress ?? email,
  };
}

/** Like findPbPatient but returns ALL search candidates (for confidence
 *  scoring + tie detection by the IV poster). */
export async function searchPbPatientCandidates(
  session: PbSession,
  query: string,
  limit = 8,
): Promise<PbPatient[]> {
  const cleaned = query.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const q = encodeURIComponent(cleaned).replace(/%20/g, "+");
  const url = `${PB_BASE}/api/consultant/records/search?countlimit=${limit}&limit=${limit}&query=${q}`;
  const res = await pbRequest(url, { method: "GET", headers: pbApiHeaders(session) });
  if (res.statusCode === 401 || res.statusCode === 403) {
    await res.body.text().catch(() => {});
    throw new PbAuthError(`PB candidate search failed ${res.statusCode}`, res.statusCode);
  }
  if (res.statusCode !== 200) {
    throw new Error(`PB candidate search failed ${res.statusCode}`);
  }
  const json = (await res.body.json()) as {
    items: Array<{ id: string; profile: { firstName: string; lastName: string; dayOfBirth?: string; emailAddress?: string; homePhone?: string; mobilePhone?: string } }>;
  };
  return (json.items ?? []).map((it) => ({
    id: it.id,
    firstName: it.profile.firstName,
    lastName: it.profile.lastName,
    dayOfBirth: it.profile.dayOfBirth ?? null,
    emailAddress: it.profile.emailAddress ?? null,
    phone: it.profile.homePhone ?? it.profile.mobilePhone ?? null,
  }));
}

// ── Upload token (gets a pre-signed S3 PUT URL) ──────────────────────

type UploadTokenResult = { fileToken: string; uploadUrl: string };

async function requestUploadToken(
  session: PbSession,
  opts: { fileName: string; fileSize: number; contentType: string },
): Promise<UploadTokenResult> {
  // PB batches multiple sub-requests under one /api/batch call. For uploads,
  // the sub-request is api/uploads/token with a stringified JSON content.
  const inner = JSON.stringify({
    path: "/labrequests",
    fileName: opts.fileName,
    fileSize: opts.fileSize,
    contentType: opts.contentType,
    isMultipartSupported: true,
  });
  const batchBody = [
    { name: 0, method: "POST", path: "api/uploads/token", content: inner },
  ];
  const res = await pbRequest(`${PB_BASE}/api/batch?context=uploadTokens`, {
    method: "POST",
    headers: {
      ...pbApiHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify(batchBody),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`PB upload-token failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const arr = (await res.body.json()) as Array<{
    status: number;
    content: {
      fileToken: string;
      parts: Array<{ uploadUrl: string; partNumber: number; partSize: number }>;
    };
  }>;
  const first = arr[0];
  if (!first || first.status !== 200) {
    throw new Error(`PB upload-token inner status ${first?.status ?? "?"}`);
  }
  return {
    fileToken: first.content.fileToken,
    uploadUrl: first.content.parts[0].uploadUrl,
  };
}

// ── S3 PUT ───────────────────────────────────────────────────────────

async function uploadPdfToS3(
  uploadUrl: string,
  pdfBytes: Buffer,
): Promise<string> {
  const res = await request(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/pdf" },
    body: pdfBytes,
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`S3 PUT failed ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const versionId = res.headers["x-amz-version-id"];
  if (!versionId || Array.isArray(versionId)) {
    throw new Error("S3 PUT response missing x-amz-version-id");
  }
  await res.body.text(); // drain
  return versionId;
}

// ── Create labrequest ────────────────────────────────────────────────

async function createLabRequest(
  session: PbSession,
  opts: {
    patientId: string;
    consultantId: string;
    labName: string;
    dateOrdered: string;
    fileToken: string;
    externalVersionKey: string;
    isClientFacing: boolean;
    notify: boolean;
  },
): Promise<string> {
  const body = {
    clientRecordId: opts.patientId,
    // "published" (not "draft") so the lab goes live in the client's portal —
    // a draft is staff-only and never notifies the patient even with notify=true.
    publishStatus: "published",
    // "resultsavailable" is what staff selected during the capture — it
    // surfaces the lab in PB's "Results Available" filter for review.
    requestStatus: "resultsavailable",
    object: "labrequest",
    dateOrdered: opts.dateOrdered,
    includeFhr: false,
    isClientFacing: opts.isClientFacing,
    notify: opts.notify,
    name: opts.labName,
    artifacts: [],
    asConsultantId: opts.consultantId,
    mediaUploads: [
      {
        fileToken: opts.fileToken,
        externalVersionKey: opts.externalVersionKey,
      },
    ],
  };
  const res = await pbRequest(`${PB_BASE}/api/consultant/labrequests`, {
    method: "POST",
    headers: {
      ...pbApiHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    const text = await res.body.text();
    throw new Error(
      `PB labrequest create failed ${res.statusCode}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.body.json()) as { id?: string };
  if (!json.id) throw new Error("PB labrequest create returned no id");
  return json.id;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export async function uploadPdfToPb(input: UploadInput): Promise<UploadResult> {
  const session = await pbLogin(input.username, input.password);

  let patient = await findPbPatient(
    session,
    input.patientName,
    input.patientDob,
    input.patientEmail,
  );
  let createdPatient = false;
  if (!patient) {
    // findPbPatient returns null for two reasons: a genuinely-new patient (no
    // chart), or several same-name charts it refuses to guess between. Only the
    // FORMER should auto-create — making a chart when one already exists would
    // duplicate it. findPbPatient resolves by name OR exact email, so the create
    // guard must check BOTH: a chart under a typo'd name but the same email must
    // hold, not spawn a duplicate (the email-only existence path the review
    // flagged). Hold if any same-name OR same-email chart exists.
    const sameName = await searchPbPatientCandidates(session, input.patientName);
    const sameEmail = input.patientEmail
      ? (await searchPbPatientCandidates(session, input.patientEmail)).filter(
          (c) => (c.emailAddress ?? "").toLowerCase() === input.patientEmail!.toLowerCase(),
        )
      : [];
    if (sameName.length > 0 || sameEmail.length > 0) {
      throw new Error(
        `PB chart may already exist for ${input.patientName} ` +
          `(${sameName.length} same-name, ${sameEmail.length} same-email) and no DOB to ` +
          `disambiguate — holding for human review rather than risk a duplicate chart`,
      );
    }
    if (!input.patientEmail) {
      throw new Error(`No PB chart for ${input.patientName} and no email on file to create one`);
    }
    const comma = input.patientName.includes(",");
    const toks = comma
      ? input.patientName.split(",").map((s) => s.trim())
      : input.patientName.trim().split(/\s+/);
    const firstName = comma ? toks[1] ?? "" : toks[0] ?? "";
    const lastName = comma ? toks[0] ?? "" : toks.slice(1).join(" ");
    if (!firstName || !lastName) {
      throw new Error(`Cannot split "${input.patientName}" into first/last to create a PB chart`);
    }
    patient = await createPbPatient(session, {
      firstName,
      lastName,
      email: input.patientEmail,
      dob: input.patientDob ?? null,
    });
    createdPatient = true;
  }
  if (input.expectedPatientId && patient.id !== input.expectedPatientId) {
    throw new Error(
      `post-test guardrail: resolved PB patient ${patient.id} ` +
        `(${patient.firstName} ${patient.lastName}) != expected ${input.expectedPatientId} — ` +
        `aborting before any write`,
    );
  }

  const pdfBytes = await readFile(input.pdfPath);
  const { fileToken, uploadUrl } = await requestUploadToken(session, {
    fileName: input.pdfFilename,
    fileSize: pdfBytes.length,
    contentType: "application/pdf",
  });

  const externalVersionKey = await uploadPdfToS3(uploadUrl, pdfBytes);

  const labRequestId = await createLabRequest(session, {
    patientId: patient.id,
    consultantId: input.consultantId,
    labName: input.labName,
    dateOrdered: input.dateOrdered,
    fileToken,
    externalVersionKey,
    isClientFacing: input.isClientFacing ?? false,
    notify: input.notify ?? true,
  });

  return { labRequestId, patientId: patient.id, createdPatient };
}

// ── List labrequests for a patient (backfill brain) ─────────────────
//
// PB endpoint observed in capture HAR:
//   GET /api/consultant/labrequests?records=<patientId>&limit=100&sort=orderdate_desc&status=draft,published
//
// Returns array of labrequest objects. Used by the backfill brain to
// determine "is this tracker case already on the patient's PB chart?"
// before silently advancing step5.

export type PbLabRequest = {
  id: string;
  /** Display name shown on the patient's chart, e.g. "Access — Acc# 007143558". */
  name: string;
  /** Date the lab was ordered (ISO). */
  dateOrdered: string;
  /** PB embeds the patient record as a nested object. The `records` query
   * param doesn't actually filter by this — paradoxically, the only way
   * to match labrequests to patients is to pull consultant-wide and
   * filter by clientRecord.id locally. Discovered 2026-05-26 during
   * Leila backfill (1669 labrequests existed; records= filter returned 0). */
  clientRecord?: {
    id: string;
    profile?: { firstName?: string; lastName?: string; emailAddress?: string };
  };
  /** Free-text status / lifecycle hint from PB. */
  status?: string;
  /** Set when the labrequest was created; useful for "ordered before X" filtering. */
  created?: string;
  /** Other fields PB returns — kept loose so we don't break on schema drift. */
  [extra: string]: unknown;
};

export async function listPatientLabRequests(
  session: PbSession,
  patientId: string,
  opts: { limit?: number; status?: string | null } = {},
): Promise<PbLabRequest[]> {
  const limit = opts.limit ?? 200;
  // Default: omit the status filter entirely so we see ALL labrequests
  // regardless of lifecycle stage (draft / published / completed / sent
  // / etc.). The backfill brain needs to see finalized labrequests, which
  // a narrow status=draft,published filter excludes — discovered preview-
  // running against Leila Centner 2026-05-26. Pass an explicit value to
  // scope; pass null to omit (the default).
  const status = opts.status === undefined ? null : opts.status;

  let url =
    `${PB_BASE}/api/consultant/labrequests` +
    `?limit=${limit}` +
    `&records=${encodeURIComponent(patientId)}` +
    `&sort=orderdate_desc`;
  if (status) url += `&status=${encodeURIComponent(status)}`;

  const res = await pbRequest(url, {
    method: "GET",
    headers: pbApiHeaders(session),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `PB list labrequests failed ${res.statusCode}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.body.json()) as
    | { data?: PbLabRequest[] }
    | PbLabRequest[]
    | { labrequests?: PbLabRequest[] };

  // PB has used 3 envelope shapes across versions — be defensive.
  if (Array.isArray(json)) return json;
  if ("data" in json && Array.isArray(json.data)) return json.data;
  if ("labrequests" in json && Array.isArray(json.labrequests))
    return json.labrequests;
  return [];
}

/** Pulls every labrequest the consultant has access to in a single call.
 *  PB's records=<id> filter doesn't actually scope by patient (discovered
 *  2026-05-26 — see PbLabRequest.clientRecord comment). The reliable way
 *  to find labs for a specific patient is to pull everything once and
 *  filter by clientRecord.id in memory.
 *
 *  PB's endpoint supports limit up to at least 5000; 2000 returns the
 *  full 1669-row Centner roster in one call. Increase opts.limit if the
 *  count grows past ~5000 — at that point switch to a paginated approach. */
export async function listAllConsultantLabRequests(
  session: PbSession,
  opts: { limit?: number; sort?: string } = {},
): Promise<PbLabRequest[]> {
  const limit = opts.limit ?? 2000;
  const sort = opts.sort ?? "orderdate_desc";
  const url =
    `${PB_BASE}/api/consultant/labrequests` +
    `?limit=${limit}&sort=${encodeURIComponent(sort)}`;
  const res = await pbRequest(url, {
    method: "GET",
    headers: pbApiHeaders(session),
  });
  if (res.statusCode === 401 || res.statusCode === 403) {
    await res.body.text().catch(() => {});
    throw new PbAuthError(
      `PB list consultant labrequests failed ${res.statusCode}`,
      res.statusCode,
    );
  }
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `PB list consultant labrequests failed ${res.statusCode}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.body.json()) as
    | { items?: PbLabRequest[]; count?: number; hasMore?: boolean }
    | PbLabRequest[];
  const items = Array.isArray(json) ? json : json.items ?? [];
  // Sanity-check: warn if the API still claims hasMore so we don't
  // silently miss data when the roster grows past our limit.
  if (!Array.isArray(json) && json.hasMore) {
    console.warn(
      `[PB] listAllConsultantLabRequests: hasMore=true at limit=${limit}, ` +
        `count=${json.count} — bump limit or implement pagination.`,
    );
  }
  return items;
}
