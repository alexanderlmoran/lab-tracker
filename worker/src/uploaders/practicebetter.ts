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
import { request } from "undici";

const PB_BASE = "https://my.practicebetter.io";
// This client_id is the public web client; identical for all PB tenants. Pulled
// from the OAuth call in the capture HAR — not secret.
const PB_CLIENT_ID = "099153c2625149bc8ecb3e85e03f0022";

// ── Types ────────────────────────────────────────────────────────────

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
function pbApiHeaders(session: PbSession): Record<string, string> {
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
  const res = await request(`${PB_BASE}/api/oauth2/token`, {
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
): Promise<PbPatient | null> {
  // PB's search expects + for spaces (literal +, not %20). We normalize "Last,
  // First" or "First Last" to a plain space-separated string then re-encode.
  const cleaned = patientName.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const query = encodeURIComponent(cleaned).replace(/%20/g, "+");
  const url = `${PB_BASE}/api/consultant/records/search?countlimit=8&limit=8&query=${query}`;
  const res = await request(url, {
    method: "GET",
    headers: pbApiHeaders(session),
  });
  if (res.statusCode !== 200) {
    throw new Error(`PB patient search failed ${res.statusCode}`);
  }
  const json = (await res.body.json()) as {
    items: Array<{
      id: string;
      profile: {
        firstName: string;
        lastName: string;
        dayOfBirth?: string;
        emailAddress?: string;
      };
    }>;
  };
  if (json.items.length === 0) return null;

  let candidates = json.items;
  if (dob) {
    const dobMatches = candidates.filter((it) =>
      (it.profile.dayOfBirth ?? "").startsWith(dob),
    );
    // Only narrow if DOB matched at least one — otherwise leave full list so
    // the caller sees a single fuzzy match rather than no match at all.
    if (dobMatches.length > 0) candidates = dobMatches;
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
  const res = await request(`${PB_BASE}/api/batch?context=uploadTokens`, {
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
    publishStatus: "draft",
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
  const res = await request(`${PB_BASE}/api/consultant/labrequests`, {
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

  const patient = await findPbPatient(
    session,
    input.patientName,
    input.patientDob,
  );
  if (!patient) {
    throw new Error(`PB patient not found: ${input.patientName}`);
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

  return { labRequestId, patientId: patient.id };
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

  const res = await request(url, {
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
  const res = await request(url, {
    method: "GET",
    headers: pbApiHeaders(session),
  });
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
