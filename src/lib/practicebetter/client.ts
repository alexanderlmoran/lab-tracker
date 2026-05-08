import "server-only";
import {
  getPracticeBetterAccessToken,
  invalidatePracticeBetterToken,
} from "./token";

const BASE_URL = "https://api.practicebetter.io";

export type PBClientRecordSummary = {
  id: string;
  status: string | null;
  client: {
    id?: string;
    emailAddress?: string;
  } | null;
  profile: {
    firstName?: string;
    lastName?: string;
    emailAddress?: string;
    notes?: string;
  } | null;
  relatedTags: Array<{ id: string; dateAdded?: string }>;
};

class PracticeBetterError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function pbFetch(
  path: string,
  init: RequestInit & { retried?: boolean } = {},
): Promise<Response> {
  const token = await getPracticeBetterAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (res.status === 401 && !init.retried) {
    invalidatePracticeBetterToken();
    return pbFetch(path, { ...init, retried: true });
  }
  return res;
}

async function pbJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await pbFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new PracticeBetterError(
      res.status,
      text.slice(0, 500),
      `PB ${init.method ?? "GET"} ${path} → ${res.status}`,
    );
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * Returns the raw JSON from page 1 of /consultant/records, with no filters.
 * The `count` field is documented as the total record count visible to this
 * API client — useful to distinguish "PB scoped our key" from "our pagination
 * is broken."
 */
export async function pbDumpFirstPage(): Promise<{
  ok: true;
  count: number | null;
  hasMore: boolean | null;
  itemsReturned: number;
  firstFiveEmails: string[];
} | { ok: false; status: number | null; error: string }> {
  try {
    const json = await pbJson<{
      count?: number;
      hasMore?: boolean;
      items?: PBClientRecordSummary[];
    }>("/consultant/records?limit=10");
    const items = json.items ?? [];
    const emails = items
      .slice(0, 5)
      .map(
        (i) =>
          i.profile?.emailAddress ?? i.client?.emailAddress ?? "(no email)",
      );
    return {
      ok: true,
      count: typeof json.count === "number" ? json.count : null,
      hasMore: typeof json.hasMore === "boolean" ? json.hasMore : null,
      itemsReturned: items.length,
      firstFiveEmails: emails,
    };
  } catch (err) {
    if (err instanceof PracticeBetterError) {
      return { ok: false, status: err.status, error: err.body || err.message };
    }
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Unknown",
    };
  }
}

/** Fetch a record by ID — used by manual-link to verify a pasted record_id. */
export async function getRecordById(
  recordId: string,
): Promise<PBClientRecordSummary | null> {
  try {
    return await pbJson<PBClientRecordSummary>(
      `/consultant/records/${encodeURIComponent(recordId)}`,
    );
  } catch (err) {
    if (err instanceof PracticeBetterError && err.status === 404) return null;
    throw err;
  }
}

/** Health probe — small list call to verify auth + connectivity. */
export async function pbHealthCheck(): Promise<{
  ok: true;
  count: number;
} | { ok: false; status: number | null; error: string }> {
  try {
    const json = await pbJson<{ count?: number; items?: unknown[] }>(
      "/consultant/records?limit=1",
    );
    return { ok: true, count: json.count ?? json.items?.length ?? 0 };
  } catch (err) {
    if (err instanceof PracticeBetterError) {
      return { ok: false, status: err.status, error: err.body || err.message };
    }
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/** Walk the records list and return the first record whose profile email matches (case-insensitive). */
export async function findRecordByEmail(
  email: string,
): Promise<PBClientRecordSummary | null> {
  const result = await findRecordByEmailWithDiagnostics(email);
  return result.match;
}

/** Same as findRecordByEmail, plus stats useful when the lookup misses. */
export async function findRecordByEmailWithDiagnostics(email: string): Promise<{
  match: PBClientRecordSummary | null;
  scanned: number;
  pagesScanned: number;
  hadMoreAfterScan: boolean;
  sampleEmailsSeen: string[];
}> {
  const target = email.trim().toLowerCase();
  if (!target) {
    return {
      match: null,
      scanned: 0,
      pagesScanned: 0,
      hadMoreAfterScan: false,
      sampleEmailsSeen: [],
    };
  }

  // PB has no server-side email filter, so we paginate. Cap at ~3,000 records
  // (30 pages × 100). Account currently has ~1,400 clients; revisit if it grows
  // past this — at PB's 5 req/s limit, a worst-case scan takes ~6s.
  let afterId: string | null = null;
  let scanned = 0;
  let pagesScanned = 0;
  const sample: string[] = [];

  for (let page = 0; page < 30; page++) {
    const qs = new URLSearchParams({ details: "true", limit: "100" });
    if (afterId) qs.set("after_id", afterId);
    const json = await pbJson<{
      items?: PBClientRecordSummary[];
      hasMore?: boolean;
    }>(`/consultant/records?${qs.toString()}`);
    const items = json.items ?? [];
    pagesScanned++;
    scanned += items.length;
    for (const item of items) {
      const profEmail = item.profile?.emailAddress?.trim();
      const clientEmail = item.client?.emailAddress?.trim();
      const emails = [profEmail, clientEmail].filter(Boolean) as string[];
      if (sample.length < 8 && emails[0]) sample.push(emails[0]);
      if (emails.some((e) => e.toLowerCase() === target)) {
        return {
          match: item,
          scanned,
          pagesScanned,
          hadMoreAfterScan: Boolean(json.hasMore),
          sampleEmailsSeen: sample,
        };
      }
    }
    if (!json.hasMore || items.length === 0) {
      return {
        match: null,
        scanned,
        pagesScanned,
        hadMoreAfterScan: false,
        sampleEmailsSeen: sample,
      };
    }
    afterId = items[items.length - 1]?.id ?? null;
    if (!afterId) {
      return {
        match: null,
        scanned,
        pagesScanned,
        hadMoreAfterScan: Boolean(json.hasMore),
        sampleEmailsSeen: sample,
      };
    }
  }
  throw new Error(
    `findRecordByEmail: scanned 3000 records without finding ${email} — extend the search cap or add a synced clients cache.`,
  );
}

export type PBPageLog = {
  page: number;
  itemsReturned: number;
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
};

/**
 * Walk every page of /consultant/records under one query-variant, accumulating
 * results and a per-page log so we can see exactly when/why pagination stopped.
 *
 * PB's records list is sorted DESCENDING by date created, so we paginate with
 * `before_id` (per their docs: "Use this to fetch more objects if the list is
 * sorted in descending order"). Using `after_id` here returns hasMore=false
 * after page 2 — that was the silent bug.
 */
export async function listAllRecordsWithLog(
  extraQuery: Record<string, string>,
  opts: { maxPages?: number; cursor?: "before" | "after" } = {},
): Promise<{
  items: PBClientRecordSummary[];
  pages: PBPageLog[];
  cursorMode: "before" | "after";
  stoppedReason:
    | "hasMore_false"
    | "items_empty"
    | "no_cursor_id"
    | "max_pages_hit";
}> {
  const maxPages = opts.maxPages ?? 50;
  const cursorMode = opts.cursor ?? "before";
  const cursorParam = cursorMode === "before" ? "before_id" : "after_id";
  const all: PBClientRecordSummary[] = [];
  const pages: PBPageLog[] = [];
  let cursorId: string | null = null;

  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ limit: "100", ...extraQuery });
    if (cursorId) qs.set(cursorParam, cursorId);
    const json = await pbJson<{
      items?: PBClientRecordSummary[];
      hasMore?: boolean;
    }>(`/consultant/records?${qs.toString()}`);
    const items = json.items ?? [];
    pages.push({
      page: p + 1,
      itemsReturned: items.length,
      hasMore: Boolean(json.hasMore),
      firstId: items[0]?.id ?? null,
      lastId: items[items.length - 1]?.id ?? null,
    });
    all.push(...items);
    if (items.length === 0) {
      return { items: all, pages, cursorMode, stoppedReason: "items_empty" };
    }
    if (!json.hasMore) {
      return { items: all, pages, cursorMode, stoppedReason: "hasMore_false" };
    }
    // For descending lists with before_id, the next cursor is the LAST item's id
    // (oldest on this page). For ascending lists with after_id, also the last id.
    const nextCursor = items[items.length - 1]?.id ?? null;
    if (!nextCursor) {
      return { items: all, pages, cursorMode, stoppedReason: "no_cursor_id" };
    }
    cursorId = nextCursor;
  }
  return { items: all, pages, cursorMode, stoppedReason: "max_pages_hit" };
}

/**
 * Diagnostic: attempt minimal POSTs to /consultant/labrequests and
 * /consultant/sessionnotes against the given client record. Returns the
 * status codes and response bodies so we can see which writes PB allows
 * for our API client and what fields they require.
 */
export async function probeWriteEndpoints(args: {
  recordId: string;
  caseId: string;
  labName: string;
}): Promise<{
  labRequest: { method: string; status: number; body: string };
  sessionNote: { method: string; status: number; body: string };
}> {
  const labRequestBody = {
    clientRecord: { id: args.recordId },
    name: `lab-tracker probe: ${args.labName}`,
    dateOrdered: new Date().toISOString(),
  };
  const sessionNoteBody = {
    clientRecord: { id: args.recordId },
    name: `lab-tracker probe`,
    notes: `Probe note from lab-tracker case ${args.caseId} at ${new Date().toISOString()}.`,
    sessionDate: new Date().toISOString(),
  };

  async function probe(path: string, payload: unknown) {
    const res = await pbFetch(path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    return { method: "POST", status: res.status, body: text.slice(0, 500) };
  }

  const [labRequest, sessionNote] = await Promise.all([
    probe("/consultant/labrequests", labRequestBody),
    probe("/consultant/sessionnotes", sessionNoteBody),
  ]);

  return { labRequest, sessionNote };
}

/** Create a new PB client record from minimal fields (name + email). */
export async function createRecord(args: {
  firstName: string;
  lastName: string;
  email: string;
}): Promise<PBClientRecordSummary> {
  const body = {
    isActive: true,
    sendInvitation: false,
    profile: {
      firstName: args.firstName,
      lastName: args.lastName,
      emailAddress: args.email,
    },
  };
  return pbJson<PBClientRecordSummary>("/consultant/records", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getRecord(recordId: string): Promise<PBClientRecordSummary> {
  return pbJson<PBClientRecordSummary>(
    `/consultant/records/${encodeURIComponent(recordId)}`,
  );
}

/**
 * Append text to the record's profile.notes (read-merge-write, since PB has no
 * native append endpoint). Idempotent on `marker`: if the marker is already
 * present in the existing notes, this is a no-op.
 *
 * Tries PATCH first (partial update), then falls back to PUT if PATCH errors.
 * After the write, GETs the record back and verifies the marker is actually
 * present — otherwise PB silently ignored our update and we should fail loudly.
 */
export async function appendNotesToRecord(args: {
  recordId: string;
  blockToAppend: string;
  marker: string;
}): Promise<{
  updated: boolean;
  methodUsed?: "PATCH" | "PUT";
  responseStatus?: number;
  verifyResponseBody?: string;
}> {
  const record = await getRecord(args.recordId);
  const existing = record.profile?.notes ?? "";
  if (existing.includes(args.marker)) {
    return { updated: false };
  }
  const merged = existing.trim()
    ? `${existing.trim()}\n\n${args.blockToAppend}`
    : args.blockToAppend;

  const path = `/consultant/records/${encodeURIComponent(args.recordId)}`;
  const body = JSON.stringify({
    profile: { ...(record.profile ?? {}), notes: merged },
  });

  let writeRes = await pbFetch(path, { method: "PATCH", body });
  let methodUsed: "PATCH" | "PUT" = "PATCH";
  if (writeRes.status === 405 || writeRes.status === 404) {
    writeRes = await pbFetch(path, { method: "PUT", body });
    methodUsed = "PUT";
  }
  if (!writeRes.ok) {
    const text = await writeRes.text().catch(() => "");
    throw new PracticeBetterError(
      writeRes.status,
      text.slice(0, 500),
      `PB ${methodUsed} ${path} → ${writeRes.status}`,
    );
  }

  // Verify: GET the record again and ensure our marker is now in profile.notes.
  // If not, PB accepted the call but didn't persist the change — surface that.
  const after = await getRecord(args.recordId);
  const persistedNotes = after.profile?.notes ?? "";
  if (!persistedNotes.includes(args.marker)) {
    throw new Error(
      `Wrote to PB via ${methodUsed} (${writeRes.status}) but readback shows the note was not persisted. ` +
        `Existing notes length: ${existing.length}. After write notes length: ${persistedNotes.length}. ` +
        `This usually means the API client does not have permission to update profile.notes, or PB is using a different field name.`,
    );
  }

  return { updated: true, methodUsed, responseStatus: writeRes.status };
}

export { PracticeBetterError };
